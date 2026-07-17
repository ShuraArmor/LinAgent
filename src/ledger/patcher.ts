/**
 * 应用 LedgerPatch 到 Ledger 上。RFC 6902 风格的 add / replace / remove。
 *
 * 设计原则：
 *   - fail-safe：单条 patch 失败不阻塞整批；失败的 patch 记进 report.failed，
 *     调用方（Agent）负责把它写进 trace 供调试，但不 throw 出去打断 chat。
 *   - id 完全由 runtime 分配：LLM 在 patch 的 value 里不填 id，patcher 用
 *     allocateItemId 分配并回填到 assigned_ids。这样 id 命名空间稳定，也避免
 *     LLM 起冲突/无意义 id。
 *   - 路径三级上限：core.* / suggested.<slot>[/id[/field]] / custom.<ns>.<field>[/id[/field]]。
 *     深度更深的 patch 一律拒绝，逼 LLM 用 replace 重写整个条目而不是打乱结构。
 *
 * 注意：patcher 不写盘、不动 updated_at。调用方（Agent）批量应用完 patch 后
 * 才刷 updated_at + 调 store.save。
 */

import type { Ledger, LedgerItem, LedgerPatch, PatchReport } from './types.ts';
import { allocateItemId } from './ledger.ts';

const IDENT = /^[a-z][a-z0-9_]*$/;

/** 顶层字段路径：core / suggested / custom / preset_used。 */
type ParsedPath =
  | { kind: 'core_field'; field: 'intent' | 'state' | 'language' }
  | { kind: 'preset'; }
  | { kind: 'suggested_array'; slot: SuggestedSlot }
  | { kind: 'suggested_item'; slot: SuggestedSlot; itemId: string; subfield?: string }
  | { kind: 'custom_array'; namespace: string; field: string }
  | { kind: 'custom_item'; namespace: string; field: string; itemId: string; subfield?: string };

type SuggestedSlot =
  | 'progress' | 'findings' | 'decisions' | 'open_threads' | 'blockers' | 'artifacts';

const SUGGESTED_SLOTS: readonly SuggestedSlot[] = [
  'progress', 'findings', 'decisions', 'open_threads', 'blockers', 'artifacts',
] as const;

class PatchError extends Error {}

/**
 * 解析路径字符串。合法形态：
 *   core.intent | core.state | core.language
 *   preset_used
 *   suggested.<slot>
 *   suggested.<slot>[<id>]
 *   suggested.<slot>[<id>].<field>
 *   custom.<ns>.<field>
 *   custom.<ns>.<field>[<id>]
 *   custom.<ns>.<field>[<id>].<field>
 */
export function parsePath(path: string): ParsedPath {
  if (typeof path !== 'string' || !path.length) throw new PatchError('path 为空');

  if (path === 'preset_used') return { kind: 'preset' };

  if (path.startsWith('core.')) {
    const field = path.slice(5);
    if (field !== 'intent' && field !== 'state' && field !== 'language') {
      throw new PatchError(`core 下无字段: ${field}`);
    }
    return { kind: 'core_field', field };
  }

  if (path.startsWith('suggested.')) {
    // suggested.<slot>[<id>]?.<subfield>?
    const rest = path.slice('suggested.'.length);
    const m = /^([a-z_]+)(?:\[([a-z0-9_]+)\])?(?:\.([a-z_]+))?$/i.exec(rest);
    if (!m) throw new PatchError(`suggested 路径不合法: ${path}`);
    const [, slot, id, subfield] = m;
    if (!SUGGESTED_SLOTS.includes(slot as SuggestedSlot)) {
      throw new PatchError(`未知 suggested slot: ${slot}`);
    }
    if (id === undefined) return { kind: 'suggested_array', slot: slot as SuggestedSlot };
    return { kind: 'suggested_item', slot: slot as SuggestedSlot, itemId: id, subfield };
  }

  if (path.startsWith('custom.')) {
    // custom.<ns>.<field>[<id>]?.<subfield>?
    const rest = path.slice('custom.'.length);
    const m = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(?:\[([a-z0-9_]+)\])?(?:\.([a-z_]+))?$/.exec(rest);
    if (!m) throw new PatchError(`custom 路径不合法: ${path}`);
    const [, namespace, field, id, subfield] = m;
    if (!IDENT.test(namespace)) throw new PatchError(`namespace 非法: ${namespace}`);
    if (!IDENT.test(field)) throw new PatchError(`custom field 非法: ${field}`);
    if (id === undefined) return { kind: 'custom_array', namespace, field };
    return { kind: 'custom_item', namespace, field, itemId: id, subfield };
  }

  throw new PatchError(`不支持的顶层路径: ${path}`);
}

function ensureCustomArray(ledger: Ledger, ns: string, field: string): LedgerItem[] {
  const key = `${ns}.${field}`;
  if (!ledger.custom[key]) ledger.custom[key] = [];
  return ledger.custom[key];
}

function ensureSuggested(ledger: Ledger, slot: SuggestedSlot): LedgerItem[] {
  if (!ledger.suggested[slot]) ledger.suggested[slot] = [];
  return ledger.suggested[slot]!;
}

/**
 * value 是 add 到数组时的条目载体。允许字段：text（必需）/ status / evidence / meta。
 * id / created_turn / archived_ref 由 runtime 分配，LLM 传了也忽略。
 */
function buildItemFromValue(value: unknown, ledger: Ledger, turn: number, prefix: string): { item: LedgerItem; assignedId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PatchError('add 到数组的 value 必须是对象');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string' || !v.text.trim()) {
    throw new PatchError('add 的 value 缺少 text 字段');
  }
  const id = allocateItemId(ledger, prefix);
  const item: LedgerItem = {
    id,
    text: v.text.trim(),
    created_turn: turn,
  };
  if (typeof v.status === 'string' && v.status.trim()) item.status = v.status.trim();
  if (Array.isArray(v.evidence)) {
    item.evidence = v.evidence.filter((e): e is string => typeof e === 'string');
  }
  if (v.meta && typeof v.meta === 'object' && !Array.isArray(v.meta)) {
    const meta: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.meta as Record<string, unknown>)) {
      if (typeof val === 'string') meta[k] = val;
      else if (typeof val === 'number' || typeof val === 'boolean') meta[k] = String(val);
    }
    if (Object.keys(meta).length) item.meta = meta;
  }
  return { item, assignedId: id };
}

/** 短前缀：找 slot / field 首字母，方便看 id 就知道是啥类别的条目。 */
function idPrefixFor(parsed: ParsedPath): string {
  if (parsed.kind === 'suggested_array' || parsed.kind === 'suggested_item') {
    return parsed.slot[0];
  }
  if (parsed.kind === 'custom_array' || parsed.kind === 'custom_item') {
    return parsed.field[0];
  }
  return 'f';
}

function findItem(items: LedgerItem[], id: string): { idx: number; item: LedgerItem } {
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) throw new PatchError(`id 不存在: ${id}`);
  return { idx, item: items[idx] };
}

function assignSubfield(item: LedgerItem, subfield: string, value: unknown): void {
  if (subfield === 'text') {
    if (typeof value !== 'string' || !value.trim()) throw new PatchError('text 必须是非空字符串');
    item.text = value.trim();
  } else if (subfield === 'status') {
    if (value == null) delete item.status;
    else if (typeof value !== 'string') throw new PatchError('status 必须是字符串');
    else item.status = value.trim();
  } else if (subfield === 'archived_ref') {
    if (value == null) delete item.archived_ref;
    else if (typeof value !== 'string') throw new PatchError('archived_ref 必须是字符串');
    else item.archived_ref = value;
  } else if (subfield === 'meta') {
    if (value == null) delete item.meta;
    else if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PatchError('meta 必须是对象');
    } else {
      const meta: Record<string, string> = {};
      for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
        if (typeof val === 'string') meta[k] = val;
        else if (typeof val === 'number' || typeof val === 'boolean') meta[k] = String(val);
      }
      item.meta = meta;
    }
  } else {
    throw new PatchError(`不允许修改条目的字段: ${subfield}`);
  }
}

/**
 * 应用一批 patch。单条失败不影响其它。
 */
export function applyPatches(ledger: Ledger, patches: LedgerPatch[], turn: number): PatchReport {
  const report: PatchReport = { applied: [], failed: [], assigned_ids: [] };
  for (const patch of patches) {
    try {
      const assigned = applyOne(ledger, patch, turn);
      report.applied.push(patch);
      report.assigned_ids.push(assigned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.failed.push({ patch, error: msg });
    }
  }
  return report;
}

function applyOne(ledger: Ledger, patch: LedgerPatch, turn: number): string | null {
  if (!patch || typeof patch !== 'object') throw new PatchError('patch 不是对象');
  if (patch.op !== 'add' && patch.op !== 'replace' && patch.op !== 'remove') {
    throw new PatchError(`未知 op: ${patch.op}`);
  }
  const parsed = parsePath(patch.path);

  // ── core.* ──────────────────────────────────────────────────────────
  if (parsed.kind === 'core_field') {
    if (patch.op === 'remove') throw new PatchError('core 字段不允许 remove');
    if (parsed.field === 'state') {
      if (patch.value !== 'active' && patch.value !== 'wrapping' && patch.value !== 'closed') {
        throw new PatchError(`core.state 只能是 active|wrapping|closed`);
      }
      ledger.core.state = patch.value;
    } else {
      if (typeof patch.value !== 'string') throw new PatchError(`core.${parsed.field} 必须是字符串`);
      ledger.core[parsed.field] = patch.value.trim();
    }
    return null;
  }

  // ── preset_used ─────────────────────────────────────────────────────
  if (parsed.kind === 'preset') {
    if (patch.op === 'remove') { delete ledger.preset_used; return null; }
    if (typeof patch.value !== 'string') throw new PatchError('preset_used 必须是字符串');
    ledger.preset_used = patch.value;
    return null;
  }

  // ── suggested slot 数组本身 ──────────────────────────────────────────
  if (parsed.kind === 'suggested_array') {
    if (patch.op === 'add') {
      const arr = ensureSuggested(ledger, parsed.slot);
      const { item, assignedId } = buildItemFromValue(patch.value, ledger, turn, idPrefixFor(parsed));
      arr.push(item);
      return assignedId;
    }
    if (patch.op === 'remove') { delete ledger.suggested[parsed.slot]; return null; }
    throw new PatchError('对 suggested slot 数组本身只能 add / remove（要改单条请指定 id）');
  }

  // ── suggested slot 里的单条 ─────────────────────────────────────────
  if (parsed.kind === 'suggested_item') {
    const arr = ledger.suggested[parsed.slot];
    if (!arr) throw new PatchError(`suggested.${parsed.slot} 不存在`);
    const { idx, item } = findItem(arr, parsed.itemId);
    if (parsed.subfield) {
      if (patch.op === 'remove') { assignSubfield(item, parsed.subfield, null); return null; }
      assignSubfield(item, parsed.subfield, patch.value);
      return null;
    }
    if (patch.op === 'remove') { arr.splice(idx, 1); return null; }
    if (patch.op === 'replace') {
      const { item: newItem, assignedId } = buildItemFromValue(patch.value, ledger, turn, idPrefixFor(parsed));
      // replace 保留原 id，把 runtime 分配的那个 id 回滚（免得 next_item_id 白涨）。
      // 简单起见不回滚 next_item_id —— id 空洞是无害的。
      newItem.id = parsed.itemId;
      arr[idx] = newItem;
      return assignedId;
    }
    throw new PatchError('对单条既不 remove 也不 replace，用 add 请指向数组本身');
  }

  // ── custom.<ns>.<field> 数组本身 ────────────────────────────────────
  if (parsed.kind === 'custom_array') {
    if (patch.op === 'add') {
      const arr = ensureCustomArray(ledger, parsed.namespace, parsed.field);
      const { item, assignedId } = buildItemFromValue(patch.value, ledger, turn, idPrefixFor(parsed));
      arr.push(item);
      return assignedId;
    }
    if (patch.op === 'remove') {
      delete ledger.custom[`${parsed.namespace}.${parsed.field}`];
      return null;
    }
    throw new PatchError('对 custom 数组本身只能 add / remove');
  }

  // ── custom.<ns>.<field>[id] 单条 ────────────────────────────────────
  if (parsed.kind === 'custom_item') {
    const key = `${parsed.namespace}.${parsed.field}`;
    const arr = ledger.custom[key];
    if (!arr) throw new PatchError(`custom.${key} 不存在`);
    const { idx, item } = findItem(arr, parsed.itemId);
    if (parsed.subfield) {
      if (patch.op === 'remove') { assignSubfield(item, parsed.subfield, null); return null; }
      assignSubfield(item, parsed.subfield, patch.value);
      return null;
    }
    if (patch.op === 'remove') { arr.splice(idx, 1); return null; }
    if (patch.op === 'replace') {
      const { item: newItem, assignedId } = buildItemFromValue(patch.value, ledger, turn, idPrefixFor(parsed));
      newItem.id = parsed.itemId;
      arr[idx] = newItem;
      return assignedId;
    }
    throw new PatchError('对单条既不 remove 也不 replace');
  }

  throw new PatchError('unreachable');
}
