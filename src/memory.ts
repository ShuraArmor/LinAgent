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
 * 分词器：产出两类 token
 *   - ≥2 字符的拉丁/数字段（转小写、整段作为一个 token）
 *   - 单个 CJK 字符（一个字一个 token）
 * 这样"machine learning"和"机器学习"都能得到有意义的重叠计算，
 * 且不需要引入分词库。对短用户事实的去重/检索来说粗但够用。
 */
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  // 拉丁/数字段
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2 || STOP.has(raw)) continue;
    out.add(raw);
  }
  // CJK 单字，一个字一个 token
  const cjk = /\p{Script=Han}/gu;
  for (const m of lower.matchAll(cjk)) {
    if (!STOP.has(m[0])) out.add(m[0]);
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
  const alive = mem.facts.filter((f) => !f.superseded_by);
  const always = alive.filter((f) => f.layer === 'identity' || f.layer === 'preferences');
  const searchable = alive.filter((f) => f.layer === 'facts' || f.layer === 'ongoing');
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

/** 纯内存版 store —— 不落盘，仅供测试使用。 */
export class MemoryMemoryStore implements MemoryStore {
  readonly location = '<memory>';
  private data = new Map<string, UserMemory>();
  load(userId: string): UserMemory {
    let m = this.data.get(userId);
    if (!m) { m = { userId, facts: [], next_id: 1 }; this.data.set(userId, m); }
    return m;
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
      return parsed;
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
