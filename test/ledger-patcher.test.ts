import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyLedger, applyPatches, parsePath,
  type LedgerPatch,
} from '../src/ledger/index.ts';

test('patcher: add finding — id 由 runtime 分配，text 落位', () => {
  const l = createEmptyLedger('s1');
  const patches: LedgerPatch[] = [
    { op: 'add', path: 'suggested.findings', value: { text: 'staging.host:22 可通' } },
  ];
  const report = applyPatches(l, patches, 3);
  assert.equal(report.applied.length, 1);
  assert.equal(report.failed.length, 0);
  const items = l.suggested.findings!;
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'staging.host:22 可通');
  assert.equal(items[0].created_turn, 3);
  // id 是 f1（前缀 "f" 取自 findings 首字母 + next_item_id 从 1 开始）
  assert.equal(items[0].id, 'f1');
  assert.equal(report.assigned_ids[0], 'f1');
});

test('patcher: 连续 add — id 递增，next_item_id 累加', () => {
  const l = createEmptyLedger('s1');
  const patches: LedgerPatch[] = [
    { op: 'add', path: 'suggested.findings', value: { text: 'a' } },
    { op: 'add', path: 'suggested.decisions', value: { text: 'b' } },
    { op: 'add', path: 'suggested.progress', value: { text: 'c' } },
  ];
  const report = applyPatches(l, patches, 1);
  assert.equal(report.applied.length, 3);
  assert.deepEqual(report.assigned_ids, ['f1', 'd2', 'p3']);
  assert.equal(l.next_item_id, 4);
});

test('patcher: replace 单条 — id 保持不变', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.findings', value: { text: '旧版本' } },
  ], 1);
  applyPatches(l, [
    { op: 'replace', path: 'suggested.findings[f1]', value: { text: '新版本' } },
  ], 2);
  const items = l.suggested.findings!;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'f1');
  assert.equal(items[0].text, '新版本');
});

test('patcher: 改单条子字段 status', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.open_threads', value: { text: 'CI secret 未配' } },
  ], 1);
  const report = applyPatches(l, [
    { op: 'replace', path: 'suggested.open_threads[o1].status', value: 'resolved' },
  ], 5);
  assert.equal(report.failed.length, 0);
  assert.equal(l.suggested.open_threads![0].status, 'resolved');
});

test('patcher: remove 单条', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.findings', value: { text: 'x' } },
    { op: 'add', path: 'suggested.findings', value: { text: 'y' } },
  ], 1);
  applyPatches(l, [
    { op: 'remove', path: 'suggested.findings[f1]' },
  ], 2);
  const items = l.suggested.findings!;
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'f2');
});

test('patcher: 自定义命名空间 —— add 会自动创建', () => {
  const l = createEmptyLedger('s1');
  const patches: LedgerPatch[] = [
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: '症状→根因→修复' } },
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: '另一条链' } },
    { op: 'add', path: 'custom.editing.final_version', value: { text: '最终稿' } },
  ];
  const report = applyPatches(l, patches, 1);
  assert.equal(report.applied.length, 3);
  assert.equal(report.failed.length, 0);
  assert.equal(l.custom['debug.causal_chain'].length, 2);
  assert.equal(l.custom['editing.final_version'].length, 1);
  // id 前缀取 field 首字母：causal_chain → c1/c2；final_version → f3
  assert.equal(l.custom['debug.causal_chain'][0].id, 'c1');
  assert.equal(l.custom['debug.causal_chain'][1].id, 'c2');
  assert.equal(l.custom['editing.final_version'][0].id, 'f3');
});

test('patcher: core 字段更新', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'replace', path: 'core.intent', value: '部署项目上线' },
    { op: 'replace', path: 'core.state', value: 'wrapping' },
  ], 1);
  assert.equal(l.core.intent, '部署项目上线');
  assert.equal(l.core.state, 'wrapping');
});

test('patcher: core.state 只接受合法值', () => {
  const l = createEmptyLedger('s1');
  const report = applyPatches(l, [
    { op: 'replace', path: 'core.state', value: 'garbage' },
  ], 1);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /state/);
  // core.state 保持默认 active 不受影响
  assert.equal(l.core.state, 'active');
});

test('patcher: 非法命名空间被拒', () => {
  const l = createEmptyLedger('s1');
  const report = applyPatches(l, [
    // 大写不允许
    { op: 'add', path: 'custom.Debug.chain', value: { text: 'x' } },
    // 缺少 field
    { op: 'add', path: 'custom.debug', value: { text: 'x' } },
    // 缺 text
    { op: 'add', path: 'suggested.findings', value: { status: 'wip' } },
  ], 1);
  assert.equal(report.applied.length, 0);
  assert.equal(report.failed.length, 3);
});

test('patcher: 未知 slot 被拒', () => {
  const l = createEmptyLedger('s1');
  const report = applyPatches(l, [
    { op: 'add', path: 'suggested.doesnotexist', value: { text: 'x' } },
  ], 1);
  assert.equal(report.failed.length, 1);
});

test('patcher: 单条 patch 失败不影响其它', () => {
  const l = createEmptyLedger('s1');
  const report = applyPatches(l, [
    { op: 'add', path: 'suggested.findings', value: { text: '好条目' } },
    { op: 'replace', path: 'core.state', value: 'nonsense' },   // 失败
    { op: 'add', path: 'suggested.decisions', value: { text: '决策 A' } },
  ], 2);
  assert.equal(report.applied.length, 2);
  assert.equal(report.failed.length, 1);
  assert.equal(l.suggested.findings!.length, 1);
  assert.equal(l.suggested.decisions!.length, 1);
});

test('patcher: id 不存在的 replace 失败', () => {
  const l = createEmptyLedger('s1');
  const report = applyPatches(l, [
    { op: 'replace', path: 'suggested.findings[f999]', value: { text: 'x' } },
  ], 1);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /f999|不存在/);
});

test('parsePath: 解析各种路径形式', () => {
  const cases: Array<[string, string]> = [
    ['core.intent', 'core_field'],
    ['core.state', 'core_field'],
    ['preset_used', 'preset'],
    ['suggested.findings', 'suggested_array'],
    ['suggested.findings[f1]', 'suggested_item'],
    ['suggested.findings[f1].status', 'suggested_item'],
    ['custom.debug.chain', 'custom_array'],
    ['custom.debug.chain[c1]', 'custom_item'],
    ['custom.debug.chain[c1].text', 'custom_item'],
  ];
  for (const [path, expectKind] of cases) {
    const parsed = parsePath(path);
    assert.equal(parsed.kind, expectKind, `路径 ${path}`);
  }
});

test('parsePath: 非法路径 throw', () => {
  assert.throws(() => parsePath(''));
  assert.throws(() => parsePath('unknown_toplevel'));
  assert.throws(() => parsePath('core.unknown'));
  assert.throws(() => parsePath('custom.'));
  assert.throws(() => parsePath('custom.Ns.field'));
});
