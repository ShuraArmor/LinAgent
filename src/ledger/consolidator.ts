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
 * 主入口 —— 把账本条目路由成 FactCandidate 后交给 memory 层合并。
 * 幂等：重复调用会因 Jaccard 去重刷新 last_seen_at 而不新增。
 */
export function consolidateLedgerToMemory(
  ledger: Ledger,
  mem: UserMemory,
  now: number = Date.now(),
): ConsolidateReport {
  const candidates: FactCandidate[] = [];

  // ── suggested slots ─────────────────────────────────────────────────
  const s = ledger.suggested;
  addFromSlot(candidates, s.findings,     SUGGESTED_ROUTES.findings);
  addFromSlot(candidates, s.decisions,    SUGGESTED_ROUTES.decisions);
  addFromSlot(candidates, s.progress,     SUGGESTED_ROUTES.progress);
  addFromSlot(candidates, s.open_threads, SUGGESTED_ROUTES.open_threads);
  addFromSlot(candidates, s.blockers,     SUGGESTED_ROUTES.blockers);
  addFromSlot(candidates, s.artifacts,    SUGGESTED_ROUTES.artifacts);

  // ── custom namespaces ───────────────────────────────────────────────
  for (const [nsField, items] of Object.entries(ledger.custom)) {
    const [namespace] = nsField.split('.');
    const rule = routeCustomNamespace(namespace);
    addFromSlot(candidates, items, rule);
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

function addFromSlot(
  out: FactCandidate[],
  items: LedgerItem[] | undefined,
  rule: RouteRule | null,
): void {
  if (!rule || !items) return;
  for (const item of items) {
    if (shouldSkip(rule, item)) continue;
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
    });
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
