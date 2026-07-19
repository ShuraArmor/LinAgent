/**
 * 跨会话记忆：按用户维度、分层、可编辑、可审计。
 *
 * 设计目标（相对于"平铺一份消息归档"这种做法）：
 *   - 分层，各层有不同的保留 / 注入策略：
 *       identity     — 稳定属性         （每次都注入）
 *       preferences  — 用户偏好         （每次都注入）
 *       facts        — 一般性事实       （按关键词匹配注入）
 *       ongoing      — 有时间范围的事件 （按关键词匹配注入）
 *   - 每条 fact 都带出处（session id + 轮次），方便审计/撤回。
 *   - 冲突走"替代"而不是"追加"：新 fact 与旧 fact 抵触时，旧的被标 `superseded_by`；
 *     旧的仍留在磁盘上（保留审计链），但检索/注入时只会看到新的。
 *   - 重复走关键词 Jaccard 去重，不会重复入库。
 *   - 用户可以通过 `memory` 工具编辑自己的记忆（见 tools/memory.ts）。
 *
 * 有意"不做"的（当前 demo 阶段做了就是过度设计）：
 *   - Embedding 检索 —— 用简单 keyword Jaccard 已经足够展示形状。
 *   - 异步 ingest 队列 —— 现在同步执行，每轮结束抽一次。
 *   - 完整多用户鉴权 —— `userId` 只是一个开关，不是完整身份系统。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type MemoryLayer = 'identity' | 'preferences' | 'facts' | 'ongoing';

/**
 * 显著性层（tier）—— 与 layer（语义桶）正交的一根轴，反馈驱动，**真正决定注入行为**。
 *   frozen  注入冻结 system prompt（会话内稳定）
 *   warm    recall_memory 按需召回
 *   dormant 默认不注入不召回，只深召回可达（归档但不遗忘）
 * 初值由 layer 派生（identity/preferences→frozen，facts/ongoing→warm），之后按 recall 反馈升降级。
 * 详见 docs/design-primitive-compression.md 记忆重构章。
 */
export type MemoryTier = 'frozen' | 'warm' | 'dormant';

/** layer → tier 初值。 */
export function defaultTierFor(layer: MemoryLayer): MemoryTier {
  return layer === 'identity' || layer === 'preferences' ? 'frozen' : 'warm';
}

/** 动态分层参数（M2）——手调初值，靠实测磨。 */
export interface TieringConfig {
  /** warm→frozen 升级门槛：累计召回次数 ≥ 此值。 */
  promoteAtRecalls: number;
  /** frozen→warm 降级：距上次召回（或创建）超过此毫秒数且非用户断言。 */
  demoteAfterMs: number;
  /** warm→dormant 降级：距上次接触超过此毫秒数且 confidence 低于 dormantMaxConf。 */
  dormantAfterMs: number;
  dormantMaxConf: number;
  /** frozen 层容量上限（防冻结 prompt 膨胀）；超了把最低分的逐回 warm。 */
  frozenCap: number;
}

export const DEFAULT_TIERING: TieringConfig = {
  promoteAtRecalls: 3,
  demoteAfterMs: 30 * 24 * 3600 * 1000,   // 30 天没被召回的 frozen 降 warm
  dormantAfterMs: 90 * 24 * 3600 * 1000,  // 90 天没接触的 warm 降 dormant
  dormantMaxConf: 0.75,
  frozenCap: 24,
};

/**
 * frozen 池里一条 fact 的"保留分"——决定 frozenCap 超限时谁被逐回 warm。
 * 用户断言的（identity 类）几乎不可动（+1000）；其余按召回次数 + confidence。
 */
function frozenScore(f: Fact): number {
  const asserted = f.tags?.includes('user_asserted') ? 1000 : 0;
  return asserted + (f.recall_count ?? 0) * 2 + f.confidence;
}

/**
 * 重算所有 fact 的 tier（M2 核心）——**只在会话启动 freeze 时调用**。
 *
 * 为什么只在 freeze 时：freezeSystemPrompt 把 frozen 层快照进 system 后整会话复用以保
 * provider 前缀缓存。tier 若在会话中途变，注入内容就变、每轮破缓存。所以升降级一律
 * 推迟到下次 freeze 统一算——会话内 recall_count 照常累加，但 tier 不动。
 *
 * 规则：
 *   warm  → frozen ：recall_count ≥ promoteAtRecalls（被反复召回 = 显著性被低估）
 *   frozen→ warm   ：非用户断言 且 距上次召回 > demoteAfterMs（冷了，别占冻结预算）
 *   warm  → dormant：距上次接触 > dormantAfterMs 且 confidence < dormantMaxConf（几乎死了）
 *   frozen 超 frozenCap：按 frozenScore 逐回 warm，直到不超（负反馈稳态）
 *
 * 就地改 mem.facts 的 tier；返回变更计数（供 trace / 落盘判断）。
 */
export function recomputeTiers(
  mem: UserMemory,
  now: number = Date.now(),
  cfg: TieringConfig = DEFAULT_TIERING,
): { promoted: number; demoted: number; dormant: number; evicted: number } {
  let promoted = 0, demoted = 0, dormant = 0, evicted = 0;
  const alive = mem.facts.filter((f) => !f.superseded_by);

  for (const f of alive) {
    if (!f.tier) f.tier = defaultTierFor(f.layer);
    const lastTouch = f.last_recalled_at ?? f.last_seen_at ?? f.created_at;
    const asserted = f.tags?.includes('user_asserted');

    if (f.tier === 'warm') {
      if ((f.recall_count ?? 0) >= cfg.promoteAtRecalls) { f.tier = 'frozen'; promoted++; }
      else if (now - lastTouch > cfg.dormantAfterMs && f.confidence < cfg.dormantMaxConf) {
        f.tier = 'dormant'; dormant++;
      }
    } else if (f.tier === 'frozen') {
      // 用户断言的身份/偏好不因"冷"降级（它们本就稳定、不靠召回证明价值）。
      if (!asserted && now - lastTouch > cfg.demoteAfterMs) { f.tier = 'warm'; demoted++; }
    } else if (f.tier === 'dormant') {
      // 沉睡的被再次召回（recall_count 涨了）→ 复活回 warm。
      if ((f.recall_count ?? 0) >= 1 && now - lastTouch < cfg.dormantAfterMs) { f.tier = 'warm'; }
    }
  }

  // frozen 容量控制器：超上限就把最低分的逐回 warm（稳态负反馈，防冻结 prompt 膨胀）。
  let frozen = alive.filter((f) => f.tier === 'frozen');
  if (frozen.length > cfg.frozenCap) {
    frozen.sort((a, b) => frozenScore(a) - frozenScore(b)); // 低分在前
    const overflow = frozen.length - cfg.frozenCap;
    for (let i = 0; i < overflow; i++) { frozen[i].tier = 'warm'; evicted++; }
  }

  return { promoted, demoted, dormant, evicted };
}

export interface Fact {
  id: string;
  layer: MemoryLayer;
  text: string;
  confidence: number;         // 0.5–1.0
  created_at: number;
  last_seen_at: number;
  source: { session: string; turn: number; class?: string };
  superseded_by?: string;     // 若被替代，指向那条新 fact 的 id
  tags?: string[];            // 可选：粗粒度类别标签，由抽取器填
  /** 从账本原语带过来的语义角色（claim/choice/cause/...）。仅 consolidation 来源的 fact 有。 */
  kind?: string;
  /** 显著性层。缺省时按 layer 派生（见 defaultTierFor）。 */
  tier?: MemoryTier;
  /** 被 recall_memory 命中的累计次数（负反馈信号，freeze 时据此升降级）。 */
  recall_count: number;
  /** 最近一次被召回命中的时间戳。 */
  last_recalled_at?: number;
}

export interface UserMemory {
  userId: string;
  facts: Fact[];              // all facts across all layers; layer is on each fact
  next_id: number;
}

/**
 * 召回重排偏置（由 ConversationClass 派生，见 ledger/class-policy.ts 的 RecallBias）。
 * 定义在这里避免 memory.ts → ledger 的反向依赖。只用于对**已相关**结果加权重排。
 */
export interface RecallReRankBias {
  /** 当前会话类别；同类别来源的 fact 加权。 */
  class?: string;
  /** 偏好的层，命中加权。 */
  preferLayers?: Array<'facts' | 'ongoing'>;
  /** 特征词，fact 文本命中加权。 */
  boostKeywords?: string[];
}

// ── 分词 / 相似度 ────────────────────────────────────────────────

const STOP = new Set([
  'the','a','an','is','are','was','were','be','to','of','in','on','at','and','or','but',
  'i','my','me','you','your','it','this','that','for','with','by','as','from','so',
  '的','了','是','在','和','或','但','我','你','的','就','都','也','有','会','要',
]);

/**
 * 别名 / 同义词表（M3）—— 把不同写法收敛到同一个规范 token。
 * 每组第一个是规范形；组内任何词（含规范形自己）出现时，都**额外**加一个 `~规范形` token
 * （不替换原 token，故精确匹配仍占优、召回精度不掉）。
 *
 * 诚实边界：这里只做**形态归一 + 精确同义**（缩写、中英对照、包管理器家族）。
 * 不做开放域上位词/语义泛化（那需要词向量，非本层目标）。可 growable：往下加组即可。
 * CJK 短语（如"配置"）在分词前先做整串子串匹配（见 tokenize 的 phrase 段）。
 */
const ALIAS_GROUPS: string[][] = [
  ['config', 'configuration', 'configure', 'cfg', '配置', '设置'],
  ['init', 'initialize', 'initialization', 'initialise', 'initializing', '初始化'],
  ['pkgmgr', 'pnpm', 'npm', 'yarn', 'bun', '包管理器', '包管理'],
  ['dependency', 'dependencies', 'dep', 'deps', '依赖'],
  ['database', 'db', '数据库'],
  ['delete', 'remove', 'del', 'rm', '删除', '移除'],
  ['directory', 'dir', 'folder', '目录', '文件夹'],
  ['repository', 'repo', '仓库'],
  ['environment', 'env', '环境'],
];

/** token → 规范形（不含前缀）。CJK 短语单列，需整串匹配。 */
const ALIAS_TOKEN = new Map<string, string>();
const ALIAS_PHRASES: Array<[string, string]> = []; // [CJK短语, 规范形]
for (const group of ALIAS_GROUPS) {
  const canon = group[0];
  for (const w of group) {
    if (/\p{Script=Han}/u.test(w)) ALIAS_PHRASES.push([w, canon]);
    else ALIAS_TOKEN.set(w, canon);
  }
}

/**
 * 轻词干：剥常见英文屈折后缀，让 deploy/deploying/deployed 落到同一 token。
 * 保守——只砍高频规则后缀，砍完至少留 3 字符；处理砍 -ing/-ed 后的辅音重复（running→run）。
 * 不做 Porter 全套（过度词干会把 university→univers 之类切错，得不偿失）。
 */
function stem(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && (s.endsWith('es'))) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  // 砍后缀造成的辅音重复：runn→run、stopp→stop。
  if (s.length >= 3 && /([bcdfghjklmnpqrstvwxz])\1$/.test(s)) s = s.slice(0, -1);
  return s.length >= 3 ? s : w; // 太短就退回原词，避免过度词干
}

/**
 * 分词器：产出（原 token）+（词干 token）+（别名规范 token）。
 *   - ≥2 字符的拉丁/数字段：转小写；加原词；加 `~词干`（英文）；命中别名再加 `~规范形`
 *   - 单个 CJK 字符：一个字一个 token
 *   - CJK 别名短语（如"配置"）：整串子串命中 → 额外加 `~规范形`
 * 原 token 始终保留，故精确重叠不被稀释；扩展 token 只增召回、不降精度。
 * 对短用户事实的去重/检索来说粗但够用，且零依赖。
 */
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  // 拉丁/数字段
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2 || STOP.has(raw)) continue;
    out.add(raw);
    // 别名规范形（缩写/同义）——命中就加，用 ~ 前缀避免和真实词碰撞。
    const canon = ALIAS_TOKEN.get(raw);
    if (canon) out.add(`~${canon}`);
    // 轻词干（仅英文字母段）——deploy/deploying/deployed 收敛。
    if (/^[a-z]+$/.test(raw)) {
      const st = stem(raw);
      if (st !== raw) out.add(`~${st}`);
    }
  }
  // CJK 单字，一个字一个 token
  const cjk = /\p{Script=Han}/gu;
  for (const m of lower.matchAll(cjk)) {
    if (!STOP.has(m[0])) out.add(m[0]);
  }
  // CJK 别名短语：整串子串匹配（"配置"→ ~config）。
  for (const [phrase, canon] of ALIAS_PHRASES) {
    if (lower.includes(phrase)) out.add(`~${canon}`);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── 各层注入策略 ────────────────────────────────────────────────────────────

/**
 * 拼 system prompt 时各层的检索策略。
 * identity / preferences 永远注入（量少、稳定、信号强）；
 * facts / ongoing 仅在与当前 query 有重叠时才注入。
 */
export function retrieveForQuery(
  mem: UserMemory,
  query: string,
  topK = 5,
  bias?: RecallReRankBias,
): Fact[] {
  // 按 tier 分区（M2）：frozen→永远注入、warm→按 query 召回、dormant→默认不可达。
  // 静态模式下 tier 恒为 layer 派生初值（id/pref→frozen、facts/ongoing→warm、无 dormant），
  // 故与旧的"按 layer 分区"结果完全一致；动态模式下则反映升降级后的真实显著性。
  const alive = mem.facts.filter((f) => !f.superseded_by);
  const always = alive.filter((f) => (f.tier ?? defaultTierFor(f.layer)) === 'frozen');
  const searchable = alive.filter((f) => (f.tier ?? defaultTierFor(f.layer)) === 'warm');
  const qTokens = tokenize(query);
  const boostTokens = bias?.boostKeywords?.length ? tokenize(bias.boostKeywords.join(' ')) : new Set<string>();
  const preferLayers = new Set(bias?.preferLayers ?? []);
  const scored = searchable
    .map((f) => {
      const base = jaccard(tokenize(f.text), qTokens);
      // 类别偏置只**重排已相关**的 fact（base>0），绝不凭空引入不相关记忆——保住召回精度。
      let bonus = 0;
      if (base > 0 && bias) {
        if (bias.class && f.source?.class === bias.class) bonus += 0.15;   // 同类别来源
        if (preferLayers.has(f.layer as 'facts' | 'ongoing')) bonus += 0.05; // 偏好层
        if (boostTokens.size) {
          const ft = tokenize(f.text);
          for (const t of boostTokens) if (ft.has(t)) { bonus += 0.05; break; } // 命中特征词
        }
      }
      return { f, score: base + bonus };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.f);
  // 永远注入的放前面，让模型先看到稳定信息。
  return [...always, ...scored];
}

/**
 * 召回反馈（M2）—— 被 recall_memory 命中的 fact 累加 recall_count、刷新 last_recalled_at。
 * 这是负反馈环的**误差信号**：被反复召回 = 显著性被低估，下次 freeze 该升级。
 * 会话内实时累加不影响任何冻结快照（tier 本身不在这里动，只在 freeze 时重算）。
 * 返回被更新的 fact 数（调用方据此决定要不要落盘）。
 */
export function bumpRecall(mem: UserMemory, ids: string[], now: number = Date.now()): number {
  if (!ids.length) return 0;
  const idSet = new Set(ids);
  let n = 0;
  for (const f of mem.facts) {
    if (idSet.has(f.id)) {
      f.recall_count = (f.recall_count ?? 0) + 1;
      f.last_recalled_at = now;
      n += 1;
    }
  }
  return n;
}

/** 序列化为一段可注入到 system prompt 的文本（每条 fact 一个 bullet）。 */
export function formatForPrompt(facts: Fact[]): string {
  if (facts.length === 0) return '';
  const byLayer: Record<MemoryLayer, Fact[]> = { identity: [], preferences: [], facts: [], ongoing: [] };
  for (const f of facts) byLayer[f.layer].push(f);
  const lines: string[] = ['关于本用户的已知信息（来自过往会话）:'];
  for (const layer of ['identity', 'preferences', 'facts', 'ongoing'] as const) {
    if (byLayer[layer].length === 0) continue;
    lines.push(`- ${layer}:`);
    for (const f of byLayer[layer]) lines.push(`    · ${f.text}`);
  }
  return lines.join('\n');
}

// ── 合并策略 ────────────────────────────────────────────────────────────

/**
 * 抽取器产出的候选 fact。`contradicts` 让抽取器显式声明"本条替代某某旧认知"
 * （比如"用户搬到上海了"标记旧的"用户住在北京"）。我们仍会自己再做一次
 * 相似度校验作为兜底。
 */
export interface FactCandidate {
  layer: MemoryLayer;
  text: string;
  confidence?: number;
  tags?: string[];
  /** Free-text hint — extractor's guess at what this replaces. Similarity check is authoritative. */
  contradicts?: string;
  /** 账本原语角色，consolidation 时由 kindOf 带上。 */
  kind?: string;
  /** 该原语的相对估值 ∈ [0,1]，consolidation 时由 valueOf 算出。M1 用作沉淀门槛。 */
  value?: number;
}

export interface MergeReport {
  added: Fact[];
  updated: Fact[];      // 命中已有，只刷新了 last_seen_at 和 confidence
  superseded: Fact[];   // 因新 fact 而被标记过期
}

/**
 * 相似度阈值。identity / ongoing 每个主题只有唯一"正确答案"（一个人只有
 * 一个常住城市、当前项目），所以中等重叠就视为冲突；facts / preferences
 * 是加性的，允许并存。
 */
const DEDUP_EXACT = 0.85;           // 极高相似度 → 视为同一条，刷新即可
const CONFLICT_ON_IDENTITY = 0.4;   // identity / ongoing 上中等重叠 → 视为冲突

export function mergeCandidates(
  mem: UserMemory,
  candidates: FactCandidate[],
  source: { session: string; turn: number; class?: string },
  now: number,
): MergeReport {
  const report: MergeReport = { added: [], updated: [], superseded: [] };
  const alive = () => mem.facts.filter((f) => !f.superseded_by);

  for (const cand of candidates) {
    if (typeof cand.text !== 'string' || !cand.text.trim()) continue;
    const candTokens = tokenize(cand.text);
    const sameLayer = alive().filter((f) => f.layer === cand.layer);

    // 同层内相似度最高的一条。
    const best = sameLayer
      .map((f) => ({ f, sim: jaccard(candTokens, tokenize(f.text)) }))
      .sort((a, b) => b.sim - a.sim)[0];

    // 1) 任何层，几乎一模一样 → 视为同一条，刷新时间戳。
    if (best && best.sim >= DEDUP_EXACT) {
      best.f.last_seen_at = now;
      best.f.confidence = Math.min(1, Math.max(best.f.confidence, cand.confidence ?? 0.8));
      report.updated.push(best.f);
      continue;
    }

    // 2) 冲突检测：
    //    (a) 抽取器给了 contradicts 提示，且能匹配到已有 fact
    //    (b) identity / ongoing 层的中等重叠 —— 新的替代旧的
    let toSupersede: Fact | undefined;
    if (cand.contradicts) {
      const hintTokens = tokenize(cand.contradicts);
      toSupersede = sameLayer.find((f) => jaccard(tokenize(f.text), hintTokens) >= CONFLICT_ON_IDENTITY);
    }
    if (!toSupersede && (cand.layer === 'identity' || cand.layer === 'ongoing')
        && best && best.sim >= CONFLICT_ON_IDENTITY) {
      toSupersede = best.f;
    }

    // 3) 写入新 fact。
    const newFact: Fact = {
      id: `f${mem.next_id++}`,
      layer: cand.layer,
      text: cand.text.trim(),
      confidence: cand.confidence ?? 0.8,
      created_at: now,
      last_seen_at: now,
      source,
      tags: cand.tags,
      kind: cand.kind,
      tier: defaultTierFor(cand.layer),
      recall_count: 0,
    };
    mem.facts.push(newFact);
    report.added.push(newFact);

    if (toSupersede) {
      toSupersede.superseded_by = newFact.id;
      report.superseded.push(toSupersede);
    }
  }
  return report;
}

// ── 手动编辑（供 `memory` 工具调用） ────────────────────────────────────

/** 硬"忘记"：标记为已过期，不写入替代 fact。 */
export function forget(mem: UserMemory, id: string): Fact | undefined {
  const f = mem.facts.find((x) => x.id === id);
  if (!f || f.superseded_by) return undefined;
  f.superseded_by = '__forgotten__';
  return f;
}

export function addManual(
  mem: UserMemory,
  layer: MemoryLayer,
  text: string,
  source: { session: string; turn: number },
  now: number,
): Fact {
  const f: Fact = {
    id: `f${mem.next_id++}`,
    layer, text: text.trim(),
    confidence: 1,          // 用户自己写下的，置信度直接给满
    created_at: now, last_seen_at: now,
    source,
    tags: ['user_asserted'],
    tier: defaultTierFor(layer),
    recall_count: 0,
  };
  mem.facts.push(f);
  return f;
}

// ── 持久化 ─────────────────────────────────────────────────────────────

export interface MemoryStore {
  location: string;
  load(userId: string): UserMemory;
  save(mem: UserMemory): void;
}

/**
 * 归一化：给旧记忆记录补齐 M0 新字段（就地修改并返回）。
 *   - 缺 recall_count → 0
 *   - 缺 tier → 按 layer 派生（defaultTierFor）
 * 旧 JSON 文件（无这些字段）因此照常加载，不丢数据、不报错。
 */
export function normalizeMemory(mem: UserMemory): UserMemory {
  for (const f of mem.facts) {
    if (typeof f.recall_count !== 'number') f.recall_count = 0;
    if (!f.tier) f.tier = defaultTierFor(f.layer);
  }
  return mem;
}

/** 纯内存版 store —— 不落盘，仅供测试使用。 */
export class MemoryMemoryStore implements MemoryStore {
  readonly location = '<memory>';
  private data = new Map<string, UserMemory>();
  load(userId: string): UserMemory {
    let m = this.data.get(userId);
    if (!m) { m = { userId, facts: [], next_id: 1 }; this.data.set(userId, m); }
    return normalizeMemory(m);
  }
  save(mem: UserMemory): void { this.data.set(mem.userId, mem); }
}

/** 落盘版 store：`<location>/<userId>.json`，一个用户一个文件。 */
export class FileMemoryStore implements MemoryStore {
  constructor(readonly location: string) { mkdirSync(location, { recursive: true }); }

  load(userId: string): UserMemory {
    const path = join(this.location, `${sanitize(userId)}.json`);
    if (!existsSync(path)) return { userId, facts: [], next_id: 1 };
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as UserMemory;
      if (!parsed.facts) parsed.facts = [];
      if (typeof parsed.next_id !== 'number') {
        parsed.next_id = Math.max(0, ...parsed.facts.map((f) => Number(f.id.slice(1)) || 0)) + 1;
      }
      return normalizeMemory(parsed);
    } catch {
      return { userId, facts: [], next_id: 1 };
    }
  }

  save(mem: UserMemory): void {
    const path = join(this.location, `${sanitize(mem.userId)}.json`);
    writeFileSync(path, JSON.stringify(mem, null, 2), 'utf8');
  }
}

function sanitize(userId: string): string {
  return userId.replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
}
