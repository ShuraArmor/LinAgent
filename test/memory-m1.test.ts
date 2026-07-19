import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consolidateLedgerToMemory, consolidateStable,
  createEmptyLedger, applyPatches,
  INCREMENTAL_MIN_VALUE, BACKSTOP_MIN_VALUE, MIN_STABLE_AGE,
} from '../src/ledger/index.ts';
import type { UserMemory } from '../src/memory.ts';

function emptyMem(): UserMemory { return { userId: 'u', facts: [], next_id: 1 }; }
const aliveTexts = (m: UserMemory) => m.facts.filter((f) => !f.superseded_by).map((f) => f.text).sort();

// ── 估值门：低价值原语进不来 ──────────────────────────────────────
test('M1 估值门: value<minValue 的原语被挡在门外', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.decisions', value: { text: '决定用连接池' } },      // choice 0.85
    { op: 'add', path: 'suggested.progress',  value: { text: '跑了一下测试' } },       // step 0.45
  ], 5);

  // 高阈值：只有 choice 过门，step 被挡。
  const mem = emptyMem();
  consolidateLedgerToMemory(l, mem, 1000, { minValue: 0.6, currentTurn: 5 });
  const texts = aliveTexts(mem);
  assert.ok(texts.includes('决定用连接池'), 'choice(0.85) 应过门');
  assert.ok(!texts.includes('跑了一下测试'), 'step(0.45) 应被挡');
});

test('M1 估值门: minValue=0（默认）等价 M0，全收', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.progress', value: { text: '跑了一下测试' } },
  ], 5);
  const mem = emptyMem();
  consolidateLedgerToMemory(l, mem, 1000);  // 无 opts → M0 行为
  // 注意 progress 路由到 null（不进记忆），换个会进的低价值项验证
  const l2 = createEmptyLedger('s2');
  applyPatches(l2, [{ op: 'add', path: 'suggested.blockers', value: { text: '等审批' } }], 5); // block 0.50
  const mem2 = emptyMem();
  consolidateLedgerToMemory(l2, mem2, 1000);
  assert.ok(aliveTexts(mem2).includes('等审批'), 'block(0.50) 默认无门应收');
});

// ── 稳定性门：太新的不沉 ───────────────────────────────────────────
test('M1 稳定性: created_turn 太新（未满 minAge）不沉', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'add', path: 'suggested.decisions', value: { text: '刚做的决定' } }], 5);
  // 该条 created_turn=5；currentTurn=5 → age=0 < MIN_STABLE_AGE
  const mem = emptyMem();
  consolidateStable(l, mem, 5, 1000);
  assert.equal(aliveTexts(mem).length, 0, '刚创建的条目不该被增量沉淀');

  // 到 turn 7（age=2）→ 稳定，应沉。
  consolidateStable(l, mem, 7, 1001);
  assert.ok(aliveTexts(mem).includes('刚做的决定'), '存活≥2轮后应沉');
});

// ── 增量幂等：打标记后不重复入库 ──────────────────────────────────
test('M1 增量: 沉过打 meta.consolidated 标记，下轮跳过不重复', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'add', path: 'suggested.decisions', value: { text: '唯一决定' } }], 1);
  const mem = emptyMem();
  consolidateStable(l, mem, 5, 1000);      // age=4 稳定，沉
  const firstCount = mem.facts.length;
  assert.equal(firstCount, 1);
  // 条目应被打标记
  const item = l.suggested.decisions![0];
  assert.equal(item.meta?.consolidated, '1', '沉后应打标记');
  // 再跑一次：skipMarked 生效，不新增
  consolidateStable(l, mem, 6, 1001);
  assert.equal(mem.facts.length, firstCount, '已标记条目不该重复入库');
});

// ── 平价门：增量+兜底 ⊇ 同阈值 wrap-only ─────────────────────────
test('M1 平价门: 增量+兜底 覆盖 ⊇ 同阈值一次性 wrap', () => {
  // 构造一份"完成态"账本：混合高/中/低价值。
  const build = () => {
    const l = createEmptyLedger('sx');
    applyPatches(l, [
      { op: 'add', path: 'suggested.decisions',    value: { text: 'D 决策' } },        // 0.85
      { op: 'add', path: 'suggested.findings',     value: { text: 'F 结论' } },        // 0.65
      { op: 'add', path: 'suggested.open_threads', value: { text: 'T 未闭线头', status: 'wip' } }, // 0.70
      { op: 'add', path: 'suggested.blockers',     value: { text: 'B 卡点' } },        // 0.50
      { op: 'add', path: 'custom.debug.cause',     value: { text: 'C 根因' } },        // 0.55
    ], 1);
    return l;
  };

  // 基线：一次性 wrap，用兜底阈值。
  const wrapLedger = build();
  const wrapMem = emptyMem();
  consolidateLedgerToMemory(wrapLedger, wrapMem, 1000, { minValue: BACKSTOP_MIN_VALUE, currentTurn: 10 });
  const wrapSet = new Set(aliveTexts(wrapMem));

  // 双路径：先几轮增量（hi 阈值 + 稳定性），再收尾兜底扫（lo 阈值）。
  const incLedger = build();
  const incMem = emptyMem();
  for (let t = 3; t <= 9; t++) consolidateStable(incLedger, incMem, t, 1000 + t); // 增量各轮
  // 收尾兜底
  consolidateLedgerToMemory(incLedger, incMem, 2000, { minValue: BACKSTOP_MIN_VALUE, currentTurn: 10 });
  const incSet = new Set(aliveTexts(incMem));

  // 平价：wrap 保住的每一条，双路径也必须有（⊇）。
  for (const t of wrapSet) {
    assert.ok(incSet.has(t), `双路径应覆盖 wrap 保住的 "${t}"`);
  }
});

// ── 阈值常量健全性 ────────────────────────────────────────────────
test('M1 阈值常量: hi>lo，MIN_STABLE_AGE≥1', () => {
  assert.ok(INCREMENTAL_MIN_VALUE > BACKSTOP_MIN_VALUE, 'hi 应严格大于 lo');
  assert.ok(MIN_STABLE_AGE >= 1);
});
