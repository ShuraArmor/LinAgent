/**
 * 原语层（Primitive layer）—— Phase 0：可观测，零行为改动。
 *
 * 核心思想（见 docs/design-primitive-compression.md）：
 * 账本是一门**通用语言**，只有一套固定的**关系角色**（原语 kind）。对话映射上来时，
 * 原语的**组合**长成不同文风 = 隐式类型。每个原语自带一个**相对估值**（不是绝对判决），
 * 组合后由整体解出处置。
 *
 * 本文件目前只提供两个纯函数：
 *   - kindOf(path, item)  账本 path / custom 命名空间 → PrimitiveKind
 *   - valueOf(item, ctx)  一条原语的相对估值 ∈ [0,1]（bias=0，Phase 2 才接反馈）
 * 都不碰压缩，只供 /ledger 观测与后续阶段调用。
 */

import type { Ledger, LedgerItem } from './types.ts';

/**
 * 原语的关系角色 —— 最小闭集，跨类型通用。
 * 不按对话类型分裂：类型是这些角色**组合出的形状**，不是另一套角色。
 */
export type PrimitiveKind =
  | 'claim'     // 结论 / 事实
  | 'choice'    // 决策 / 取舍
  | 'cause'     // 因果边
  | 'step'      // 动作 / 进展
  | 'block'     // 卡点
  | 'artifact'  // 产物
  | 'thread'    // 未闭线头
  | 'option';   // 备选 / 被否

/** suggested.<slot> → kind 的直接映射。 */
const SLOT_KIND: Record<string, PrimitiveKind> = {
  progress: 'step',
  findings: 'claim',
  decisions: 'choice',
  open_threads: 'thread',
  blockers: 'block',
  artifacts: 'artifact',
};

/**
 * custom 命名空间的 field 名 → kind 的启发式关键词。
 * 命中优先序按 KIND_HINTS 顺序；都不命中兜底 claim（保守）。
 */
const KIND_HINTS: Array<[PrimitiveKind, RegExp]> = [
  ['cause',    /(cause|causal|因果|根因|root_?cause|why|reason|chain)/i],
  ['option',   /(option|alternative|rejected|candidate|备选|方案|否决|discard)/i],
  ['choice',   /(choice|decision|decide|选择|决策|决定|verdict)/i],
  ['artifact', /(artifact|output|file|product|产物|文件|deliverable)/i],
  ['step',     /(step|action|progress|command|run|步骤|动作|执行|进展)/i],
  ['block',    /(block|blocker|stuck|卡|阻塞|waiting)/i],
  ['thread',   /(thread|todo|pending|open|未完|线头|待办)/i],
  ['claim',    /(finding|fact|conclusion|observ|结论|事实|发现|观察)/i],
];

/**
 * 把账本 path（+ 可选 item）映射到 PrimitiveKind。纯函数、零 LLM。
 *
 * path 形如：
 *   'suggested.findings'            → SLOT_KIND 直查
 *   'custom.debug.causal_chain'     → 取 namespace/field 跑 KIND_HINTS
 *   'custom.brainstorm.rejected'    → 同上
 *
 * item 目前不参与判定（预留：将来可用 meta.kind 显式覆盖）。未知一律兜底 'claim'（保守）。
 */
export function kindOf(path: string, item?: LedgerItem): PrimitiveKind {
  // 显式覆盖优先：agent 可在 meta.kind 里直接声明（若是合法 kind）。
  const declared = item?.meta?.kind;
  if (declared && isPrimitiveKind(declared)) return declared;

  const parts = path.split('.');
  if (parts[0] === 'suggested' && parts[1] && parts[1] in SLOT_KIND) {
    return SLOT_KIND[parts[1]];
  }
  if (parts[0] === 'custom') {
    // custom.<ns>.<field> —— ns 与 field 都拿来做关键词匹配（field 优先）。
    const hay = parts.slice(1).join(' ');
    for (const [kind, re] of KIND_HINTS) {
      if (re.test(hay)) return kind;
    }
  }
  return 'claim';
}

const KIND_SET: ReadonlySet<string> = new Set<PrimitiveKind>([
  'claim', 'choice', 'cause', 'step', 'block', 'artifact', 'thread', 'option',
]);

/** 类型守卫：字符串是否是合法 PrimitiveKind。 */
export function isPrimitiveKind(s: string): s is PrimitiveKind {
  return KIND_SET.has(s);
}

/**
 * 每种原语的**基础倾向** ∈ [0,1] —— 注意这是"相对估值"的起点，不是绝对判决。
 * 最终 value 由 base × 组合上下文调制得出（见 valueOf）。
 *   choice/artifact 高：决策与产物几乎总是命脉
 *   claim 中高：结论通常值得留，但要看是否被引用
 *   cause 中：因果边价值极依赖"在不在通往结论的链上"，交给上下文拉开
 *   step 中低：过程动作，产出 artifact 才升值
 *   block/thread 中：完全由 status 决定（未解高、已解低）
 *   option 中低：被选中升、被否降
 */
const BASE: Record<PrimitiveKind, number> = {
  choice: 0.85,
  artifact: 0.80,
  claim: 0.65,
  cause: 0.55,
  thread: 0.50,
  block: 0.50,
  step: 0.45,
  option: 0.45,
};

/** valueOf 的上下文：当前账本 + 当前 turn（算新旧）。都可选，缺了就退化为只看 item 自身。 */
export interface ValueContext {
  ledger?: Ledger;
  currentTurn?: number;
  /** Phase 2 反馈偏置：kind → Δ（[-0.3,0.3] 量级），现在恒为 0。 */
  bias?: Partial<Record<PrimitiveKind, number>>;
}

const DONE_RE = /done|resolved|closed|已解|完成|已完成|已闭/i;
const OPEN_RE = /wip|blocked|open|pending|进行|未完|待/i;

/**
 * 一条原语的**相对估值** ∈ [0,1]。纯函数、零 LLM。
 *
 * value = clamp( base(kind)
 *              + status 调制（已解 −；未解 +）
 *              + 被引用调制（别的条目提到我的 id → 我是承重的 +）
 *              + 新旧调制（越近的 turn 略 +，近场相关）
 *              + bias[kind]（Phase 2 反馈，现为 0） )
 *
 * 关键：这是"相对"的——同一条 cause，在被引用/在链上时高，孤立死支路时低。
 * 组合（= 类型）通过这些上下文调制项，把同一 base 拉成不同结果。
 */
export function valueOf(path: string, item: LedgerItem, ctx: ValueContext = {}): number {
  const kind = kindOf(path, item);
  let v = BASE[kind];

  // ── status 调制 ──
  const st = item.status ?? '';
  if (DONE_RE.test(st)) {
    // 已解的卡点/线头几乎无跨轮价值；已完成的动作次要。
    v -= (kind === 'block' || kind === 'thread') ? 0.35 : 0.10;
  } else if (OPEN_RE.test(st)) {
    // 未解的卡点/线头是"还欠着的债"，跨轮必须记得。
    v += (kind === 'block' || kind === 'thread') ? 0.20 : 0.05;
  }

  // ── 被引用调制：别的条目 text 里提到我的 id → 我是承重节点 ──
  if (ctx.ledger && isReferenced(ctx.ledger, item.id)) v += 0.15;

  // ── 新旧调制：越近的 turn 略微加权（近场上下文更相关）──
  if (ctx.currentTurn != null && item.created_turn >= 0) {
    const age = ctx.currentTurn - item.created_turn;
    if (age <= 1) v += 0.08;
    else if (age >= 8) v -= 0.05;
  }

  // ── Phase 2 反馈偏置（现恒 0）──
  v += ctx.bias?.[kind] ?? 0;

  return clamp01(v);
}

/** 账本里是否有**别的**条目在 text 中引用了 id（如 "见 c1"、"基于 f3"）。 */
function isReferenced(ledger: Ledger, id: string): boolean {
  const re = new RegExp(`\\b${escapeRe(id)}\\b`);
  for (const [, items] of allItemArrays(ledger)) {
    for (const it of items) {
      if (it.id !== id && re.test(it.text)) return true;
    }
  }
  return false;
}

/** 枚举账本所有 item 数组（suggested + custom）。 */
export function allItemArrays(ledger: Ledger): Array<[string, LedgerItem[]]> {
  const out: Array<[string, LedgerItem[]]> = [];
  const s = ledger.suggested;
  const slots: Array<[string, LedgerItem[] | undefined]> = [
    ['suggested.progress', s.progress],
    ['suggested.findings', s.findings],
    ['suggested.decisions', s.decisions],
    ['suggested.open_threads', s.open_threads],
    ['suggested.blockers', s.blockers],
    ['suggested.artifacts', s.artifacts],
  ];
  for (const [p, arr] of slots) if (arr && arr.length) out.push([p, arr]);
  for (const [ns, arr] of Object.entries(ledger.custom)) {
    if (arr && arr.length) out.push([`custom.${ns}`, arr]);
  }
  return out;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 观测用渲染 —— **仅供 /ledger 面板**，给每条标注 kind 和 value。
 * 刻意与 renderLedgerForPrompt 分开：那个进真实 prompt，不能被观测信息污染。
 * Phase 0 的意义：先肉眼看"估值合不合直觉"，再谈用它驱动压缩。
 */
export function renderLedgerWithPrimitives(ledger: Ledger): string {
  const arrays = allItemArrays(ledger);
  const c = ledger.core;
  const hasCore = c.intent || c.state !== 'active';
  if (!hasCore && !arrays.length) return '';

  const ctx: ValueContext = { ledger, currentTurn: ledger.turn_count };
  const lines: string[] = ['【账本 · 原语视图（kind / value）】'];
  lines.push(`  intent: ${c.intent || '(未填)'}`);
  lines.push(`  state:  ${c.state}    language: ${c.language}`);

  for (const [path, items] of arrays) {
    lines.push(`  ${path}:`);
    for (const it of items) {
      const kind = kindOf(path, it);
      const val = valueOf(path, it, ctx);
      const bar = valueBar(val);
      const st = it.status ? ` [${it.status}]` : '';
      const arc = it.archived_ref ? ` (→${it.archived_ref})` : '';
      lines.push(`    · ${it.id}  ${kind.padEnd(8)} ${bar} ${val.toFixed(2)}  ${it.text}${st}${arc}`);
    }
  }
  return lines.join('\n');
}

/** 把 [0,1] 估值渲染成一个 5 格小条，便于扫视。 */
function valueBar(v: number): string {
  const filled = Math.round(clamp01(v) * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}
