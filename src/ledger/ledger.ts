/**
 * 账本工厂 + 一致性检查 + 生存性工具函数。
 *
 * 这里不做任何 I/O（那部分在 store.ts），也不解释 patch（那部分在 patcher.ts）。
 * 纯数据操作，方便离线测试。
 */

import type { Ledger, LedgerItem } from './types.ts';

/** 空账本 —— 每个字段都到位，但都是空的。 */
export function createEmptyLedger(sessionId: string, language = 'zh', now = Date.now()): Ledger {
  return {
    version: 1,
    session_id: sessionId,
    created_at: now,
    updated_at: now,
    turn_count: 0,
    core: { intent: '', state: 'active', language },
    suggested: {},
    custom: {},
    next_item_id: 1,
  };
}

/** 分配下一个 item id（默认 f{n}；调用方可给一个语义前缀）。 */
export function allocateItemId(ledger: Ledger, prefix = 'f'): string {
  const id = `${prefix}${ledger.next_item_id}`;
  ledger.next_item_id += 1;
  return id;
}

/**
 * 从存盘加载后的账本可能缺字段（version 演进 / 老文件）—— 兜底补齐，
 * 保证代码后续用到的字段都存在。返回同一对象（in-place）。
 */
export function normalizeLedger(raw: Partial<Ledger>, sessionId: string): Ledger {
  const now = Date.now();
  const l: Ledger = {
    version: 1,
    session_id: raw.session_id ?? sessionId,
    created_at: typeof raw.created_at === 'number' ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'number' ? raw.updated_at : now,
    turn_count: typeof raw.turn_count === 'number' ? raw.turn_count : 0,
    preset_used: raw.preset_used,
    core: {
      intent: typeof raw.core?.intent === 'string' ? raw.core.intent : '',
      state:
        raw.core?.state === 'wrapping' || raw.core?.state === 'closed'
          ? raw.core.state
          : 'active',
      language: typeof raw.core?.language === 'string' ? raw.core.language : 'zh',
    },
    suggested: raw.suggested ?? {},
    custom: raw.custom ?? {},
    next_item_id: typeof raw.next_item_id === 'number' ? raw.next_item_id : recomputeNextId(raw),
  };
  return l;
}

function recomputeNextId(raw: Partial<Ledger>): number {
  let maxN = 0;
  const scan = (items?: LedgerItem[]) => {
    if (!items) return;
    for (const it of items) {
      const m = /^[a-z]+(\d+)$/.exec(it.id);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
  };
  const s = raw.suggested ?? {};
  scan(s.progress); scan(s.findings); scan(s.decisions);
  scan(s.open_threads); scan(s.blockers); scan(s.artifacts);
  for (const arr of Object.values(raw.custom ?? {})) scan(arr);
  return maxN + 1;
}

/**
 * 枚举账本里所有条目数组（用于 patcher / renderer 遍历）。
 * 返回 [路径前缀, 数组引用]，路径前缀形如 "suggested.findings" / "custom.debug.causal_chain"。
 */
export function enumerateItemArrays(
  ledger: Ledger,
): Array<{ path: string; items: LedgerItem[] }> {
  const out: Array<{ path: string; items: LedgerItem[] }> = [];
  const s = ledger.suggested;
  const suggestedKeys: Array<keyof typeof s> = [
    'progress', 'findings', 'decisions', 'open_threads', 'blockers', 'artifacts',
  ];
  for (const k of suggestedKeys) {
    if (s[k]) out.push({ path: `suggested.${k}`, items: s[k]! });
  }
  for (const [nsField, items] of Object.entries(ledger.custom)) {
    out.push({ path: `custom.${nsField}`, items });
  }
  return out;
}

/** 统计账本里的条目总数（用于 UI / 触发压缩的启发式）。 */
export function itemCount(ledger: Ledger): number {
  let n = 0;
  for (const { items } of enumerateItemArrays(ledger)) n += items.length;
  return n;
}
