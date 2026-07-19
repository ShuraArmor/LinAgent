/**
 * Consolidator —— 账本 → 记忆的桥。
 *
 * 这是 Batch 3 的核心：会话闭合时把账本条目按字段名路由到对应的记忆层。
 *
 * 核心洞察：**LLM 在把某条信息填到 findings 还是 debug.causal_chain 那一刻，
 * 它已经在做分类了**。分类工作从"通用 extractor 事后猜"挪到了"账本维护顺手做"。
 * 这里做的只是**把账本字段名映射到记忆层**，不再需要 LLM 二次抽取。
 *
 * 路由规则（可扩展）：
 *   suggested.findings        → layer=facts,    tag=finding
 *   suggested.decisions       → layer=facts,    tag=decision
 *   suggested.progress        → 不进记忆（是本会话的过程，跨会话价值低）
 *   suggested.open_threads    → layer=ongoing,  tag=thread（除非 status=resolved）
 *   suggested.blockers        → layer=ongoing,  tag=blocker（除非 status=resolved）
 *   suggested.artifacts       → 不进记忆（是本会话产物，跨会话价值低）
 *   custom.debug.*            → layer=facts,    tag=lesson
 *   custom.editing.*          → 不进记忆
 *   custom.<其它>.*           → layer=facts,    tag=<namespace>（保守默认）
 *
 * 去重靠 memory.mergeCandidates 的 Jaccard —— 二次巩固不会重复入库。
 */

import type { FactCandidate, MemoryLayer, MergeReport, UserMemory } from '../memory.ts';
import { mergeCandidates } from '../memory.ts';
import type { Ledger, LedgerItem } from './types.ts';
import { resolveClass } from './class-policy.ts';
import { kindOf, valueOf, type ValueContext, type PrimitiveKind } from './primitive.ts';

/**
 * 路由规则决定一个 slot / namespace 的条目进哪一层、打什么 tag。
 * null 表示这类条目不进记忆。
 */
export interface RouteRule {
  layer: MemoryLayer;
  tag: string;
  /** confidence 默认值（可被条目自己的 meta.confidence 覆盖）。 */
  confidence?: number;
}

/** suggested slot 的路由表；null 表示"不进记忆"。 */
const SUGGESTED_ROUTES: Record<string, RouteRule | null> = {
  progress:     null,                                     // 本会话过程，跨会话价值低
  findings:     { layer: 'facts',   tag: 'finding',   confidence: 0.85 },
  decisions:    { layer: 'facts',   tag: 'decision',  confidence: 0.9  },
  open_threads: { layer: 'ongoing', tag: 'thread',    confidence: 0.7  },
  blockers:     { layer: 'ongoing', tag: 'blocker',   confidence: 0.7  },
  artifacts:    null,                                     // 本会话产物
};

/**
 * 自定义命名空间的路由。
 * 已知命名空间给专门规则，其它 fallback 到 facts 层 + <namespace> tag。
 */
const CUSTOM_ROUTES: Record<string, RouteRule | null> = {
  debug:    { layer: 'facts', tag: 'lesson',   confidence: 0.85 },
  editing:  null,   // 编辑类：最终产物已经落盘，不再往记忆里塞
  research: { layer: 'facts', tag: 'research', confidence: 0.8  },
};

function routeCustomNamespace(ns: string): RouteRule | null {
  if (ns in CUSTOM_ROUTES) return CUSTOM_ROUTES[ns];
  // 未知命名空间保守默认：facts + ns 作为 tag。这样 emergence 分析
  // 能通过 tag 统计发现"这个命名空间高频，要不要给它专门的路由规则"。
  return { layer: 'facts', tag: ns, confidence: 0.75 };
}

/**
 * item.status == 'resolved' 的 open_threads / blockers 不需要跨会话跟踪。
 * 其它状态（wip、blocked、undefined）都保留。
 */
function shouldSkip(rule: RouteRule, item: LedgerItem): boolean {
  if (rule.layer === 'ongoing' && item.status === 'resolved') return true;
  return false;
}

export interface ConsolidateReport {
  /** 从账本产出的候选数（含被去重掉的）。 */
  candidates: number;
  /** 底层 memory 合并的具体报告。 */
  merge: MergeReport;
  /** 触发时账本的 turn 号。 */
  from_turn: number;
}

/**
 * 沉淀选项 —— M1 的估值门 + 增量/兜底控制。
 * 全部缺省时行为与 M0 完全一致（minValue=0、不限龄、不跳过、不标记）——向后兼容。
 */
export interface ConsolidateOptions {
  /** 只沉淀 valueOf ≥ minValue 的原语。默认 0（不设门）。 */
  minValue?: number;
  /** 只沉淀 created_turn ≤ currentTurn-minAge 的"稳定"原语。默认 0（不限龄）。 */
  minAge?: number;
  /** 算 age / 新旧调制用的当前 turn。默认 ledger.turn_count。 */
  currentTurn?: number;
  /** 跳过已打 meta.consolidated 标记的条目（增量模式防重复）。默认 false。 */
  skipMarked?: boolean;
  /** 沉淀成功后给条目打 meta.consolidated 标记（就地改 ledger）。默认 false。 */
  mark?: boolean;
  /** Phase 2 反馈偏置：kind → Δ，喂给 valueOf 影响估值门（越被召回的 kind 越易过门）。 */
  bias?: Partial<Record<string, number>>;
}

/** M1 阈值 —— 手调初值（同 valueOf 的 base，靠 Phase 2 反馈磨）。 */
export const INCREMENTAL_MIN_VALUE = 0.60;  // 增量：只沉稳定的高价值原语
export const BACKSTOP_MIN_VALUE = 0.35;     // 兜底：噪音地板以上全收（不丢 M0 会保的）
export const MIN_STABLE_AGE = 2;            // 稳定 = 至少存活 2 轮，防半成品锁死

/**
 * 主入口 —— 把账本条目路由成 FactCandidate 后交给 memory 层合并。
 * 幂等：重复调用会因 Jaccard 去重刷新 last_seen_at 而不新增。
 */
export function consolidateLedgerToMemory(
  ledger: Ledger,
  mem: UserMemory,
  now: number = Date.now(),
  opts: ConsolidateOptions = {},
): ConsolidateReport {
  const candidates: FactCandidate[] = [];

  // 估值上下文 + 门控参数。currentTurn 缺省用账本自己的 turn_count。
  const currentTurn = opts.currentTurn ?? ledger.turn_count;
  const vctx: ValueContext = {
    ledger, currentTurn,
    bias: opts.bias as Partial<Record<PrimitiveKind, number>> | undefined,
  };
  const gate: GateParams = {
    minValue: opts.minValue ?? 0,
    minAge: opts.minAge ?? 0,
    currentTurn,
    skipMarked: opts.skipMarked ?? false,
    mark: opts.mark ?? false,
  };

  // ── suggested slots ─────────────────────────────────────────────────
  const s = ledger.suggested;
  addFromSlot(candidates, 'suggested.findings',     s.findings,     SUGGESTED_ROUTES.findings,     vctx, gate);
  addFromSlot(candidates, 'suggested.decisions',    s.decisions,    SUGGESTED_ROUTES.decisions,    vctx, gate);
  addFromSlot(candidates, 'suggested.progress',     s.progress,     SUGGESTED_ROUTES.progress,     vctx, gate);
  addFromSlot(candidates, 'suggested.open_threads', s.open_threads, SUGGESTED_ROUTES.open_threads, vctx, gate);
  addFromSlot(candidates, 'suggested.blockers',     s.blockers,     SUGGESTED_ROUTES.blockers,     vctx, gate);
  addFromSlot(candidates, 'suggested.artifacts',    s.artifacts,    SUGGESTED_ROUTES.artifacts,    vctx, gate);

  // ── custom namespaces ───────────────────────────────────────────────
  for (const [nsField, items] of Object.entries(ledger.custom)) {
    const [namespace] = nsField.split('.');
    const rule = routeCustomNamespace(namespace);
    addFromSlot(candidates, `custom.${nsField}`, items, rule, vctx, gate);
  }

  // 给沉淀出的 fact 盖上"来源会话类别"戳 —— 召回时同类别加权重排（同一根轴）。
  const cls = resolveClass(ledger);
  const merge = mergeCandidates(
    mem,
    candidates,
    { session: ledger.session_id, turn: ledger.turn_count, class: cls },
    now,
  );

  return { candidates: candidates.length, merge, from_turn: ledger.turn_count };
}

/** 门控参数（addFromSlot 内部用）。 */
interface GateParams {
  minValue: number;
  minAge: number;
  currentTurn: number;
  skipMarked: boolean;
  mark: boolean;
}

/**
 * 增量沉淀 —— 每轮末调用。只沉"稳定的高价值"原语（value≥hi 且存活≥N 轮），
 * 沉过的打标记跳过。不再依赖 wrapping 一次性倾倒：漏标 wrapping 也不丢高价值信息。
 * 返回本次是否有新增/更新（供 agent 决定要不要落盘，省 IO）。
 */
export function consolidateStable(
  ledger: Ledger,
  mem: UserMemory,
  currentTurn: number,
  now: number = Date.now(),
  bias?: Partial<Record<string, number>>,
): ConsolidateReport {
  return consolidateLedgerToMemory(ledger, mem, now, {
    minValue: INCREMENTAL_MIN_VALUE,
    minAge: MIN_STABLE_AGE,
    currentTurn,
    skipMarked: true,
    mark: true,
    bias,
  });
}

function addFromSlot(
  out: FactCandidate[],
  path: string,
  items: LedgerItem[] | undefined,
  rule: RouteRule | null,
  vctx: ValueContext,
  gate: GateParams,
): void {
  if (!rule || !items) return;
  for (const item of items) {
    if (shouldSkip(rule, item)) continue;
    // 增量模式：跳过本轮之前已沉淀过的条目（防重复入库 + 省 tokenize）。
    if (gate.skipMarked && item.meta?.consolidated === '1') continue;
    // 稳定性门：太新的条目（可能还是半成品）先不沉，等它稳定。
    if (gate.minAge > 0 && (gate.currentTurn - item.created_turn) < gate.minAge) continue;
    // 估值门：低于阈值的原语不进记忆（M1 的核心）。
    const kind = kindOf(path, item);
    const value = valueOf(path, item, vctx);
    if (value < gate.minValue) continue;

    // 条目自己的 meta.confidence 可以覆盖 rule 默认
    const overrideConf = item.meta?.confidence != null ? Number(item.meta.confidence) : NaN;
    const conf = Number.isFinite(overrideConf) && overrideConf >= 0 && overrideConf <= 1
      ? overrideConf
      : rule.confidence ?? 0.8;
    out.push({
      layer: rule.layer,
      text: item.text,
      confidence: conf,
      tags: [rule.tag],
      kind,
      value,
    });
    // 增量模式：打标记，下轮 skipMarked 就不再重复处理（就地改 ledger，随账本落盘）。
    if (gate.mark) {
      if (!item.meta) item.meta = {};
      item.meta.consolidated = '1';
    }
  }
}

/** 供测试 / 外部工具查询：给定 slot / namespace，看它会走什么规则。 */
export function inspectRoute(kind: string): RouteRule | null {
  if (kind in SUGGESTED_ROUTES) return SUGGESTED_ROUTES[kind];
  if (kind.startsWith('custom.')) {
    const ns = kind.slice('custom.'.length).split('.')[0];
    return routeCustomNamespace(ns);
  }
  return null;
}
