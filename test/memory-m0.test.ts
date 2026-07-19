import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeCandidates, addManual, normalizeMemory, defaultTierFor,
  type UserMemory, type Fact,
} from '../src/memory.ts';
import { consolidateLedgerToMemory, createEmptyLedger, applyPatches } from '../src/ledger/index.ts';

function emptyMem(): UserMemory {
  return { userId: 'u', facts: [], next_id: 1 };
}

// ── defaultTierFor ────────────────────────────────────────────────
test('defaultTierFor: id/pref→frozen，facts/ongoing→warm', () => {
  assert.equal(defaultTierFor('identity'), 'frozen');
  assert.equal(defaultTierFor('preferences'), 'frozen');
  assert.equal(defaultTierFor('facts'), 'warm');
  assert.equal(defaultTierFor('ongoing'), 'warm');
});

// ── 新字段默认值 ──────────────────────────────────────────────────
test('mergeCandidates: 新 fact 带 recall_count=0 + tier + kind', () => {
  const mem = emptyMem();
  const rep = mergeCandidates(
    mem,
    [{ layer: 'facts', text: '根因是连接池未释放', kind: 'cause' }],
    { session: 's', turn: 3 },
    1000,
  );
  assert.equal(rep.added.length, 1);
  const f = rep.added[0];
  assert.equal(f.recall_count, 0);
  assert.equal(f.tier, 'warm', 'facts 层默认 warm');
  assert.equal(f.kind, 'cause', 'kind 应贯穿进 fact');
});

test('addManual: 用户断言的 fact 也带 tier + recall_count', () => {
  const mem = emptyMem();
  const f = addManual(mem, 'preferences', '偏好 pnpm', { session: 's', turn: 0 }, 1000);
  assert.equal(f.recall_count, 0);
  assert.equal(f.tier, 'frozen', 'preferences 层默认 frozen');
});

// ── load 归一化：旧记忆兼容 ────────────────────────────────────────
test('normalizeMemory: 旧记录缺 tier/recall_count → 补齐', () => {
  // 模拟旧 JSON 反序列化出来的 fact（没有 tier / recall_count）
  const legacy = {
    userId: 'u',
    next_id: 3,
    facts: [
      { id: 'f1', layer: 'identity', text: '用户是后端工程师', confidence: 1,
        created_at: 0, last_seen_at: 0, source: { session: 'x', turn: 0 } },
      { id: 'f2', layer: 'facts', text: '项目用 Postgres', confidence: 0.8,
        created_at: 0, last_seen_at: 0, source: { session: 'x', turn: 1 } },
    ] as unknown as Fact[],
  } as UserMemory;

  const norm = normalizeMemory(legacy);
  assert.equal(norm.facts[0].tier, 'frozen', 'identity → frozen');
  assert.equal(norm.facts[0].recall_count, 0);
  assert.equal(norm.facts[1].tier, 'warm', 'facts → warm');
  assert.equal(norm.facts[1].recall_count, 0);
});

test('normalizeMemory: 已有 tier/recall_count 不被覆盖', () => {
  const mem = {
    userId: 'u', next_id: 2,
    facts: [
      { id: 'f1', layer: 'facts', text: 'x', confidence: 0.8, created_at: 0, last_seen_at: 0,
        source: { session: 's', turn: 0 }, tier: 'frozen', recall_count: 5 },
    ] as Fact[],
  } as UserMemory;
  const norm = normalizeMemory(mem);
  assert.equal(norm.facts[0].tier, 'frozen', '已升级的 tier 不该被打回 warm');
  assert.equal(norm.facts[0].recall_count, 5, 'recall_count 不该被清零');
});

// ── consolidator: kind 贯穿 ───────────────────────────────────────
test('consolidateLedgerToMemory: 沉淀出的 fact 带正确 kind', () => {
  const l = createEmptyLedger('s1');
  l.core.intent = '排查登录报错';
  applyPatches(l, [
    { op: 'add', path: 'suggested.findings', value: { text: '登录接口 500' } },
    { op: 'add', path: 'suggested.decisions', value: { text: '决定加连接池监控' } },
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: '连接池耗尽→拒绝连接' } },
  ], 4);

  const mem = emptyMem();
  consolidateLedgerToMemory(l, mem, 2000);

  const byText = (t: string) => mem.facts.find((f) => f.text.includes(t));
  assert.equal(byText('500')?.kind, 'claim', 'findings → claim');
  assert.equal(byText('连接池监控')?.kind, 'choice', 'decisions → choice');
  assert.equal(byText('耗尽')?.kind, 'cause', 'debug.causal_chain → cause');
});
