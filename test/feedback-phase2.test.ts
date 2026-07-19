import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyFeedback, recordRecall, biasMap, normalizeFeedback,
  MemoryFeedbackStore, DEFAULT_CONTROLLER,
} from '../src/ledger/feedback.ts';

// ── 控制器：反复召回同一 kind → 其 bias 上升 ─────────────────────
test('P2 控制器: 反复召回 claim → claim 的 bias 升', () => {
  const s = emptyFeedback();
  for (let i = 0; i < 10; i++) recordRecall(s, ['claim']);
  assert.ok(s.kinds.claim!.bias > 0, 'claim 被反复召回，bias 应为正');
  assert.equal(s.kinds.claim!.recalls, 10);
});

// ── clamp：bias 不越界 ────────────────────────────────────────────
test('P2 clamp: 无限召回 bias 也不超过 clamp', () => {
  const s = emptyFeedback();
  for (let i = 0; i < 1000; i++) recordRecall(s, ['choice']);
  assert.ok(s.kinds.choice!.bias <= DEFAULT_CONTROLLER.clamp + 1e-9, '不超上钳位');
  assert.ok(s.kinds.choice!.bias >= -DEFAULT_CONTROLLER.clamp - 1e-9, '不超下钳位');
});

// ── 松回：一个 kind 涨上去后，长期不召回会衰减 ────────────────────
test('P2 松回: 升上去的 bias 在停止召回后向下松（防积分饱和）', () => {
  const s = emptyFeedback();
  for (let i = 0; i < 10; i++) recordRecall(s, ['step']);
  const peak = s.kinds.step!.bias;
  // 之后一直召回别的 kind，step 成为"负证据"。
  for (let i = 0; i < 30; i++) recordRecall(s, ['claim']);
  assert.ok(s.kinds.step!.bias < peak, 'step 长期不被召回，bias 应从峰值松回');
});

// ── boost-only：从不召回的 kind 衰减到 0，绝不驱负（回归 review #2）──
test('P2 boost-only: 从不召回的 kind bias 衰减到 0，不被压成负数', () => {
  const s = emptyFeedback();
  // step 进状态后就再不被召回，只召回 claim。
  recordRecall(s, ['claim', 'step']);
  for (let i = 0; i < 40; i++) recordRecall(s, ['claim']);
  assert.equal(s.kinds.step!.bias, 0, 'step 从不召回 → bias 衰减到 0（缺席=中性，不惩罚）');
  assert.ok(s.kinds.claim!.bias > 0, 'claim 常召回 → bias 正');
});

test('P2 boost-only: bias 下界是 0（任何序列都不产生负 bias）', () => {
  const s = emptyFeedback();
  for (let i = 0; i < 100; i++) recordRecall(s, i % 7 === 0 ? ['option'] : ['claim']);
  for (const kf of Object.values(s.kinds)) {
    assert.ok(kf!.bias >= 0, 'bias 不该为负');
  }
});

// ── biasMap：只吐非零 ─────────────────────────────────────────────
test('P2 biasMap: 只导出非零 bias 项', () => {
  const s = emptyFeedback();
  for (let i = 0; i < 5; i++) recordRecall(s, ['artifact']);
  const m = biasMap(s);
  assert.ok('artifact' in m, 'artifact 有非零 bias');
  assert.ok(Object.values(m).every((v) => v !== 0), '不含零项');
});

// ── setpoint：召回率恰在设定点附近 → bias 趋稳 ────────────────────
test('P2 setpoint: 召回率≈设定点时 bias 收敛不再猛涨', () => {
  const s = emptyFeedback();
  // 4 次里命中 1 次 claim ≈ 0.25 命中率 = 默认 setpoint。
  for (let i = 0; i < 40; i++) recordRecall(s, i % 4 === 0 ? ['claim'] : ['step']);
  // claim 的 EMA 应接近 setpoint，bias 增量趋近 0（不猛涨到 clamp）。
  assert.ok(Math.abs(s.kinds.claim!.bias) < DEFAULT_CONTROLLER.clamp, 'setpoint 附近不该顶到 clamp');
});

// ── 慢环冷启动：坏文件退化空态，好文件读回先验 ────────────────────
test('P2 慢环: 存取往返保真', () => {
  const store = new MemoryFeedbackStore();
  const s = emptyFeedback();
  for (let i = 0; i < 8; i++) recordRecall(s, ['cause']);
  store.save('u1', s);
  const back = store.load('u1');
  assert.equal(back.kinds.cause!.recalls, 8);
  assert.ok(back.kinds.cause!.bias > 0);
});

test('P2 归一化: 坏/残缺输入 → 安全空态，不抛', () => {
  assert.deepEqual(normalizeFeedback(null), emptyFeedback());
  assert.deepEqual(normalizeFeedback('garbage'), emptyFeedback());
  const partial = normalizeFeedback({ kinds: { claim: { bias: 0.1 } } });
  assert.equal(partial.kinds.claim!.bias, 0.1);
  assert.equal(partial.kinds.claim!.ema, 0, '缺失字段补 0');
});

test('P2 冷启动先验: 空 store load → 空态（不崩）', () => {
  const store = new MemoryFeedbackStore();
  assert.deepEqual(store.load('never-seen'), emptyFeedback());
});
