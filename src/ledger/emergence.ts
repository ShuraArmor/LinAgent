/**
 * 涌现分析 —— 扫全库账本，找出正在自发出现的分类结构。
 *
 * B4 你选了同步做。这里的实现刻意保守：
 *   - **只做统计和候选提议，不自动改任何东西**（不写盘、不覆盖 preset）
 *   - 结果暴露给用户 —— 由用户决定是否把候选提升为正式 preset
 *
 * 三个信号源：
 *   1. namespace 频次        —— 哪个 custom 命名空间高频（"debug 在 15 份账本里出现"）
 *   2. 字段共现矩阵          —— 哪些字段总一起出现（progress+artifacts → 执行任务型）
 *   3. intent 词聚类         —— 哪些 intent 词经常同时出现
 *
 * 稳定性判定：某个 namespace / intent 词只在 1 份账本里出现 —— 大概率是一次性的，不算涌现。
 * 阈值取 ≥ 2 份账本作为"稳定"的最低门槛（可通过参数调）。
 */

import type { Ledger } from './types.ts';

export interface EmergenceReport {
  /** 分析了多少份账本。 */
  totalLedgers: number;

  /**
   * custom namespace 频次表 —— 按出现的账本数降序。
   * 只保留 ≥ minSessions 份账本里出现过的（默认 2）。
   */
  namespaceFreq: Array<{
    namespace: string;
    sessionCount: number;    // 出现在多少份账本
    itemCount: number;       // 总条目数
    fields: string[];        // 具体用到的 field 名（去重、按频次排序）
  }>;

  /**
   * suggested slot 字段共现 —— 哪些 slot 常一起出现在同一份账本。
   * 只列共现 ≥ minSessions 次的 top pair。
   */
  cooccurrence: Array<{ pair: [string, string]; count: number }>;

  /**
   * intent 词的共现频次 —— 简单分词后统计每个词在多少份账本的 intent 里出现过。
   * 用于粗略描绘"这类账本大概在做什么"。
   */
  intentTerms: Array<{ term: string; sessionCount: number }>;

  /**
   * 候选 preset 提议 —— 一个 namespace 高频且伴随稳定的字段模式时，
   * 系统建议"要不要把它升为正式 preset"。
   */
  presetCandidates: Array<{
    suggestedName: string;      // "debug" / "refactor" ...
    reason: string;
    sessionCount: number;
    exampleFields: string[];    // 该命名空间下最常见的 fields
    suggestedKeywords: string[]; // 从这些账本的 intent 里抽的高频词
  }>;
}

export interface EmergenceOptions {
  /** 出现的账本数下限（低于视为一次性、噪声）。默认 2。 */
  minSessions?: number;
  /** namespaceFreq 返回的条数上限。默认 20。 */
  topN?: number;
  /** preset 候选提议的 sessionCount 下限。默认 3。 */
  candidateMinSessions?: number;
}

/**
 * 停用词表 —— 模块级常量，避免每次 analyzeEmergence 都重建。
 * 与 memory.ts 的 STOP 略有出入（多几个 CJK 助词），保留独立维护是有意的：
 * memory 层识别用户事实，这里识别 intent 的话题词，取舍略不同。
 */
const STOP = new Set([
  'the','a','an','is','are','was','were','be','to','of','in','on','at','and','or','but',
  'i','my','me','you','your','it','this','that','for','with','by','as','from','so',
  '的','了','是','在','和','或','但','我','你','就','都','也','有','会','要','把','对','让','个',
]);

/** intent 字符长度上限 —— 破损账本若把 intent 存成 500KB 长文本会拖慢 /emergence。 */
const INTENT_MAX_LEN = 4096;

/**
 * 主入口。传入一批账本快照（从 LedgerStore.loadAll() 拿），产出报告。
 * 纯函数，无 IO。
 */
export function analyzeEmergence(
  ledgers: Ledger[],
  opts: EmergenceOptions = {},
): EmergenceReport {
  const minSessions = Math.max(2, opts.minSessions ?? 2);
  const topN = Math.max(1, opts.topN ?? 20);
  const candidateMin = Math.max(2, opts.candidateMinSessions ?? 3);

  // ── 统计 1：namespace 频次 ────────────────────────────────────────────
  //   nsData: namespace → { sessions: Set<sessionId>, itemCount, fields: Map<field, count> }
  const nsData = new Map<string, {
    sessions: Set<string>;
    itemCount: number;
    fields: Map<string, number>;
  }>();

  for (const l of ledgers) {
    for (const [nsField, items] of Object.entries(l.custom)) {
      const [ns, field] = nsField.split('.');
      if (!ns || !field) continue;
      let d = nsData.get(ns);
      if (!d) { d = { sessions: new Set(), itemCount: 0, fields: new Map() }; nsData.set(ns, d); }
      d.sessions.add(l.session_id);
      d.itemCount += items.length;
      d.fields.set(field, (d.fields.get(field) ?? 0) + items.length);
    }
  }

  const namespaceFreq = Array.from(nsData.entries())
    .filter(([, d]) => d.sessions.size >= minSessions)
    .map(([namespace, d]) => ({
      namespace,
      sessionCount: d.sessions.size,
      itemCount: d.itemCount,
      fields: Array.from(d.fields.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([f]) => f),
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount || b.itemCount - a.itemCount)
    .slice(0, topN);

  // ── 统计 2：字段共现矩阵 ─────────────────────────────────────────────
  const SLOTS: readonly string[] = ['progress', 'findings', 'decisions', 'open_threads', 'blockers', 'artifacts'];
  const pairCount = new Map<string, number>();  // key = "a|b" (a<b sorted)
  for (const l of ledgers) {
    const active: string[] = [];
    for (const s of SLOTS) {
      const arr = (l.suggested as Record<string, unknown>)[s];
      if (Array.isArray(arr) && arr.length > 0) active.push(s);
    }
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const [a, b] = [active[i], active[j]].sort();
        const key = `${a}|${b}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  const cooccurrence = Array.from(pairCount.entries())
    .filter(([, c]) => c >= minSessions)
    .map(([key, count]) => {
      const [a, b] = key.split('|');
      return { pair: [a, b] as [string, string], count };
    })
    .sort((a, b) => b.count - a.count);

  // ── 统计 3：intent 词频次 ────────────────────────────────────────────
  // 简单分词：字母数字段（长度 ≥ 2）+ CJK 单字。跟 memory.ts 一致的策略。
  const termToSessions = new Map<string, Set<string>>();
  for (const l of ledgers) {
    const intent = (l.core.intent || '').toLowerCase().slice(0, INTENT_MAX_LEN);
    if (!intent) continue;
    const tokens = new Set<string>();
    for (const raw of intent.split(/[^a-z0-9]+/)) {
      if (raw.length >= 2 && !STOP.has(raw)) tokens.add(raw);
    }
    for (const m of intent.matchAll(/\p{Script=Han}/gu)) {
      if (!STOP.has(m[0])) tokens.add(m[0]);
    }
    for (const t of tokens) {
      let ss = termToSessions.get(t);
      if (!ss) { ss = new Set(); termToSessions.set(t, ss); }
      ss.add(l.session_id);
    }
  }
  const intentTerms = Array.from(termToSessions.entries())
    .filter(([, ss]) => ss.size >= minSessions)
    .map(([term, ss]) => ({ term, sessionCount: ss.size }))
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, topN);

  // ── preset 候选提议 ──────────────────────────────────────────────────
  // 规则：某 namespace 出现在 ≥ candidateMin 份账本 → 提议成为 preset 候选
  const presetCandidates = namespaceFreq
    .filter((n) => n.sessionCount >= candidateMin)
    .map((n) => {
      // 找出跟此 namespace 共同出现的账本，从它们的 intent 抽高频词
      const relatedLedgers = ledgers.filter((l) =>
        Object.keys(l.custom).some((k) => k.startsWith(`${n.namespace}.`)),
      );
      const kwFreq = new Map<string, number>();
      for (const l of relatedLedgers) {
        const intent = (l.core.intent || '').toLowerCase().slice(0, INTENT_MAX_LEN);
        for (const raw of intent.split(/[^a-z0-9]+/)) {
          if (raw.length >= 2 && !STOP.has(raw)) kwFreq.set(raw, (kwFreq.get(raw) ?? 0) + 1);
        }
        for (const m of intent.matchAll(/\p{Script=Han}/gu)) {
          if (!STOP.has(m[0])) kwFreq.set(m[0], (kwFreq.get(m[0]) ?? 0) + 1);
        }
      }
      const suggestedKeywords = Array.from(kwFreq.entries())
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t]) => t);

      return {
        suggestedName: n.namespace,
        reason: `custom.${n.namespace}.* 在 ${n.sessionCount} 份账本里出现，共 ${n.itemCount} 条`,
        sessionCount: n.sessionCount,
        exampleFields: n.fields.slice(0, 5),
        suggestedKeywords,
      };
    });

  return {
    totalLedgers: ledgers.length,
    namespaceFreq,
    cooccurrence,
    intentTerms,
    presetCandidates,
  };
}

/** 把报告渲染成人类可读的一段文本（REPL 展示用）。 */
export function renderEmergenceReport(r: EmergenceReport): string {
  const lines: string[] = [];
  lines.push(`【涌现分析】扫描了 ${r.totalLedgers} 份账本`);

  if (r.namespaceFreq.length === 0) {
    lines.push('');
    lines.push('  尚无稳定的 custom namespace（需要至少 2 份账本共同出现才算数）。');
  } else {
    lines.push('');
    lines.push('  稳定 custom namespace（跨会话高频）:');
    for (const n of r.namespaceFreq.slice(0, 10)) {
      lines.push(`    · ${n.namespace}  —  ${n.sessionCount} 份账本 / ${n.itemCount} 条 / fields: ${n.fields.slice(0, 4).join(', ')}`);
    }
  }

  if (r.cooccurrence.length > 0) {
    lines.push('');
    lines.push('  高频字段共现:');
    for (const c of r.cooccurrence.slice(0, 5)) {
      lines.push(`    · ${c.pair[0]} + ${c.pair[1]}  —  ${c.count} 次`);
    }
  }

  if (r.presetCandidates.length > 0) {
    lines.push('');
    lines.push('  📌 preset 候选提议（考虑把这些命名空间沉淀成正式 preset）:');
    for (const p of r.presetCandidates) {
      lines.push(`    · ${p.suggestedName}  —  ${p.reason}`);
      if (p.suggestedKeywords.length) {
        lines.push(`        建议关键词: ${p.suggestedKeywords.join(', ')}`);
      }
    }
  }

  return lines.join('\n');
}
