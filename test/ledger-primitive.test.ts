import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kindOf, valueOf, isPrimitiveKind, allItemArrays,
  renderLedgerWithPrimitives, createEmptyLedger, applyPatches,
} from '../src/ledger/index.ts';
import type { LedgerItem } from '../src/ledger/types.ts';

function item(id: string, text: string, extra: Partial<LedgerItem> = {}): LedgerItem {
  return { id, text, created_turn: 0, ...extra };
}

// ── kindOf：映射表 ────────────────────────────────────────────────
test('kindOf: suggested 槽位直查', () => {
  assert.equal(kindOf('suggested.findings'), 'claim');
  assert.equal(kindOf('suggested.decisions'), 'choice');
  assert.equal(kindOf('suggested.progress'), 'step');
  assert.equal(kindOf('suggested.open_threads'), 'thread');
  assert.equal(kindOf('suggested.blockers'), 'block');
  assert.equal(kindOf('suggested.artifacts'), 'artifact');
});

test('kindOf: custom 命名空间靠关键词', () => {
  assert.equal(kindOf('custom.debug.causal_chain'), 'cause');
  assert.equal(kindOf('custom.brainstorm.rejected'), 'option');
  assert.equal(kindOf('custom.exec.commands_run'), 'step');
  assert.equal(kindOf('custom.build.artifacts_made'), 'artifact');
});

test('kindOf: 未知命名空间兜底 claim（保守）', () => {
  assert.equal(kindOf('custom.random.xyz'), 'claim');
  assert.equal(kindOf('custom.foo.bar'), 'claim');
});

test('kindOf: meta.kind 显式覆盖优先', () => {
  const it = item('c1', '随便', { meta: { kind: 'cause' } });
  assert.equal(kindOf('suggested.findings', it), 'cause', 'meta.kind 应压过 path 推断');
  const bad = item('c2', '随便', { meta: { kind: 'notakind' } });
  assert.equal(kindOf('suggested.findings', bad), 'claim', '非法 meta.kind 忽略，回落 path');
});

test('isPrimitiveKind: 守卫', () => {
  assert.ok(isPrimitiveKind('cause'));
  assert.ok(isPrimitiveKind('artifact'));
  assert.ok(!isPrimitiveKind('nope'));
  assert.ok(!isPrimitiveKind(''));
});

// ── valueOf：相对估值单调性 ──────────────────────────────────────
test('valueOf: 未解卡点 > 已解卡点', () => {
  const open = valueOf('suggested.blockers', item('b1', '端口被占', { status: 'wip' }));
  const done = valueOf('suggested.blockers', item('b2', '端口已释放', { status: 'resolved' }));
  assert.ok(open > done, `未解(${open}) 应 > 已解(${done})`);
});

test('valueOf: 未解线头 > 已闭线头', () => {
  const open = valueOf('suggested.open_threads', item('t1', '还没写测试', { status: 'open' }));
  const done = valueOf('suggested.open_threads', item('t2', '测试写完了', { status: 'done' }));
  assert.ok(open > done);
});

test('valueOf: 决策/产物基础分高于纯过程动作', () => {
  const choice = valueOf('suggested.decisions', item('d1', '选 Postgres'));
  const step = valueOf('suggested.progress', item('p1', '跑了下 ls'));
  assert.ok(choice > step, `choice(${choice}) 应 > step(${step})`);
});

test('valueOf: 被引用的条目升值', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: '连接池未释放' } },
    { op: 'add', path: 'suggested.findings', value: { text: '根因见 c1，属资源泄漏' } },
  ], 1);
  const chain = l.custom['debug.causal_chain'];
  assert.ok(chain && chain.length === 1);
  const c1 = chain[0];
  const referenced = valueOf('custom.debug.causal_chain', c1, { ledger: l });
  const alone = valueOf('custom.debug.causal_chain', c1, {}); // 无 ledger 上下文
  assert.ok(referenced > alone, `被引用(${referenced}) 应 > 孤立(${alone})`);
});

test('valueOf: 结果恒在 [0,1]', () => {
  const hi = valueOf('suggested.decisions', item('d1', 'x', { status: 'wip' }), { currentTurn: 0 });
  const lo = valueOf('suggested.progress', item('p1', 'y', { status: 'done' }), { currentTurn: 50 });
  for (const v of [hi, lo]) {
    assert.ok(v >= 0 && v <= 1, `value ${v} 越界`);
  }
});

// ── allItemArrays / 渲染 ─────────────────────────────────────────
test('allItemArrays: 枚举 suggested + custom，跳过空', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.findings', value: { text: 'f' } },
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: 'c' } },
  ], 1);
  const arrays = allItemArrays(l);
  const paths = arrays.map(([p]) => p);
  assert.ok(paths.includes('suggested.findings'));
  assert.ok(paths.includes('custom.debug.causal_chain'));
  assert.ok(!paths.includes('suggested.progress'), '空槽位不该出现');
});

test('renderLedgerWithPrimitives: 空账本返回空串', () => {
  assert.equal(renderLedgerWithPrimitives(createEmptyLedger('s1')), '');
});

test('renderLedgerWithPrimitives: 含 kind 与数值', () => {
  const l = createEmptyLedger('s1');
  l.core.intent = '排错';
  applyPatches(l, [
    { op: 'add', path: 'suggested.decisions', value: { text: '选 B' } },
  ], 1);
  const out = renderLedgerWithPrimitives(l);
  assert.ok(out.includes('原语视图'));
  assert.ok(out.includes('choice'), '应标出 decisions→choice');
  assert.ok(/\d\.\d{2}/.test(out), '应含两位小数估值');
});
