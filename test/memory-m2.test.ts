import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recomputeTiers, bumpRecall, retrieveForQuery, defaultTierFor,
  DEFAULT_TIERING, type UserMemory, type Fact,
} from '../src/memory.ts';

let seq = 0;
function mkFact(p: Partial<Fact>): Fact {
  seq += 1;
  return {
    id: p.id ?? `f${seq}`, layer: p.layer ?? 'facts', text: p.text ?? `t${seq}`,
    confidence: p.confidence ?? 0.8, created_at: p.created_at ?? 0,
    last_seen_at: p.last_seen_at ?? 0, source: { session: 's', turn: 0 },
    recall_count: p.recall_count ?? 0, tier: p.tier ?? defaultTierFor(p.layer ?? 'facts'),
    last_recalled_at: p.last_recalled_at, tags: p.tags,
  };
}
function mem(facts: Fact[]): UserMemory { return { userId: 'u', facts, next_id: facts.length + 1 }; }

const NOW = 1_000_000_000_000;

// ── bumpRecall ────────────────────────────────────────────────────
test('M2 bumpRecall: 命中的 fact recall_count++ 且刷新时间', () => {
  const m = mem([mkFact({ id: 'f1' }), mkFact({ id: 'f2' })]);
  const n = bumpRecall(m, ['f1'], NOW);
  assert.equal(n, 1);
  assert.equal(m.facts[0].recall_count, 1);
  assert.equal(m.facts[0].last_recalled_at, NOW);
  assert.equal(m.facts[1].recall_count, 0, '未命中的不动');
});

// ── 升级：warm + 足够召回 → frozen ────────────────────────────────
test('M2 升级: warm 且 recall_count≥阈值 → frozen', () => {
  const m = mem([mkFact({ id: 'f1', layer: 'facts', recall_count: DEFAULT_TIERING.promoteAtRecalls, last_recalled_at: NOW })]);
  const d = recomputeTiers(m, NOW);
  assert.equal(m.facts[0].tier, 'frozen', '被反复召回的 fact 应升 frozen');
  assert.equal(d.promoted, 1);
});

test('M2 不升级: warm 但召回不足 → 保持 warm', () => {
  const m = mem([mkFact({ id: 'f1', recall_count: DEFAULT_TIERING.promoteAtRecalls - 1, last_recalled_at: NOW })]);
  recomputeTiers(m, NOW);
  assert.equal(m.facts[0].tier, 'warm');
});

// ── 降级：frozen 冷了 + 非用户断言 → warm ─────────────────────────
test('M2 降级: frozen 长期没召回且非 user_asserted → warm', () => {
  const old = NOW - DEFAULT_TIERING.demoteAfterMs - 1;
  const m = mem([mkFact({ id: 'f1', layer: 'preferences', tier: 'frozen', last_seen_at: old, created_at: old })]);
  const d = recomputeTiers(m, NOW);
  assert.equal(m.facts[0].tier, 'warm');
  assert.equal(d.demoted, 1);
});

test('M2 降级豁免: user_asserted 的 frozen 不因冷降级', () => {
  const old = NOW - DEFAULT_TIERING.demoteAfterMs - 1;
  const m = mem([mkFact({ id: 'f1', layer: 'identity', tier: 'frozen', tags: ['user_asserted'], last_seen_at: old, created_at: old })]);
  recomputeTiers(m, NOW);
  assert.equal(m.facts[0].tier, 'frozen', '用户断言的身份不该被降级');
});

// ── warm → dormant ────────────────────────────────────────────────
test('M2 沉睡: warm 长期没接触 + 低 conf → dormant', () => {
  const old = NOW - DEFAULT_TIERING.dormantAfterMs - 1;
  const m = mem([mkFact({ id: 'f1', tier: 'warm', confidence: 0.6, last_seen_at: old, created_at: old })]);
  const d = recomputeTiers(m, NOW);
  assert.equal(m.facts[0].tier, 'dormant');
  assert.equal(d.dormant, 1);
});

// ── frozen 容量控制器 ─────────────────────────────────────────────
test('M2 控制器: frozen 超 frozenCap → 逐回 warm 最低分者', () => {
  const cfg = { ...DEFAULT_TIERING, frozenCap: 2 };
  // 全给 recent 时间戳，避免被"冷降级"规则先动 —— 隔离出纯容量逐出逻辑。
  const facts = [
    mkFact({ id: 'a', tier: 'frozen', tags: ['user_asserted'], confidence: 1, last_seen_at: NOW, last_recalled_at: NOW }), // 高分保住
    mkFact({ id: 'b', tier: 'frozen', recall_count: 5, confidence: 0.9, last_seen_at: NOW, last_recalled_at: NOW }),        // 次高
    mkFact({ id: 'c', tier: 'frozen', recall_count: 0, confidence: 0.6, last_seen_at: NOW, last_recalled_at: NOW }),        // 最低 → 逐出
  ];
  const m = mem(facts);
  const d = recomputeTiers(m, NOW, cfg);
  assert.equal(d.evicted, 1);
  assert.equal(m.facts.find((f) => f.id === 'c')!.tier, 'warm', '最低分被逐回 warm');
  assert.equal(m.facts.find((f) => f.id === 'a')!.tier, 'frozen', '用户断言的保住');
  const frozenCount = m.facts.filter((f) => f.tier === 'frozen').length;
  assert.equal(frozenCount, 2, '不超上限');
});

// ── 注入分区随 tier 变化 ──────────────────────────────────────────
test('M2 注入: 升 frozen 的 fact 进"永远注入"区', () => {
  const m = mem([mkFact({ id: 'f1', layer: 'facts', text: '关键事实', tier: 'frozen' })]);
  // 空 query（freeze 快照）：只取 frozen 区。
  const snap = retrieveForQuery(m, '', 0);
  assert.ok(snap.some((f) => f.id === 'f1'), 'frozen 的 fact 应进空 query 快照');
});

test('M2 注入: dormant 的 fact 不进快照也不进普通召回', () => {
  const m = mem([mkFact({ id: 'f1', layer: 'facts', text: '沉睡事实 唯一词', tier: 'dormant' })]);
  const snap = retrieveForQuery(m, '', 0);
  assert.ok(!snap.some((f) => f.id === 'f1'), 'dormant 不进 frozen 快照');
  const hits = retrieveForQuery(m, '沉睡事实 唯一词', 5);
  assert.ok(!hits.some((f) => f.id === 'f1'), 'dormant 不进 warm 召回');
});

// ── 静态安全性：年轻记忆 recompute 是 no-op ───────────────────────
test('M2 安全: 年轻/无召回历史的记忆 recompute 无变更', () => {
  const m = mem([
    mkFact({ id: 'f1', layer: 'identity', tier: 'frozen', tags: ['user_asserted'], last_seen_at: NOW, created_at: NOW }),
    mkFact({ id: 'f2', layer: 'facts', tier: 'warm', last_seen_at: NOW, created_at: NOW }),
  ]);
  const d = recomputeTiers(m, NOW);
  assert.deepEqual(d, { promoted: 0, demoted: 0, dormant: 0, evicted: 0 });
});
