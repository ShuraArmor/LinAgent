import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyLedger, applyPatches,
  consolidateLedgerToMemory, inspectRoute,
} from '../src/ledger/index.ts';
import { MemoryMemoryStore } from '../src/memory.ts';

test('inspectRoute: 已知 slot 命中路由', () => {
  const findings = inspectRoute('findings');
  assert.ok(findings);
  assert.equal(findings!.layer, 'facts');
  assert.equal(findings!.tag, 'finding');

  const decisions = inspectRoute('decisions');
  assert.ok(decisions);
  assert.equal(decisions!.tag, 'decision');

  const blockers = inspectRoute('blockers');
  assert.ok(blockers);
  assert.equal(blockers!.layer, 'ongoing');
});

test('inspectRoute: progress / artifacts 不进记忆', () => {
  assert.equal(inspectRoute('progress'), null);
  assert.equal(inspectRoute('artifacts'), null);
});

test('inspectRoute: 已知 custom 命名空间命中专门规则', () => {
  const debug = inspectRoute('custom.debug.causal_chain');
  assert.ok(debug);
  assert.equal(debug!.tag, 'lesson');
  assert.equal(debug!.layer, 'facts');

  const editing = inspectRoute('custom.editing.final');
  assert.equal(editing, null);
});

test('inspectRoute: 未知 custom 命名空间 fallback 到 facts + <ns> tag', () => {
  const r = inspectRoute('custom.refactor.strategy');
  assert.ok(r);
  assert.equal(r!.layer, 'facts');
  assert.equal(r!.tag, 'refactor');
});

test('consolidate: findings → facts (tag=finding)', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'replace', path: 'core.intent', value: '部署项目' },
    { op: 'add', path: 'suggested.findings', value: { text: 'staging.host:22 可通' } },
    { op: 'add', path: 'suggested.findings', value: { text: 'CI 需要 DEPLOY_KEY' } },
  ], 3);
  l.turn_count = 3;

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  const rep = consolidateLedgerToMemory(l, mem, 1000);

  assert.equal(rep.candidates, 2);
  assert.equal(rep.merge.added.length, 2);
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 2);
  for (const f of alive) {
    assert.equal(f.layer, 'facts');
    assert.deepEqual(f.tags, ['finding']);
  }
});

test('consolidate: decisions 打 decision tag、confidence 更高', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.decisions', value: { text: '弃用方案 A 用方案 B' } },
  ], 5);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem);

  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.equal(alive[0].layer, 'facts');
  assert.deepEqual(alive[0].tags, ['decision']);
  assert.equal(alive[0].confidence, 0.9);
});

test('consolidate: progress / artifacts 不进记忆', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.progress',  value: { text: 'npm build 通过' } },
    { op: 'add', path: 'suggested.artifacts', value: { text: 'tsconfig.json 已改' } },
  ], 2);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  const rep = consolidateLedgerToMemory(l, mem);
  assert.equal(rep.candidates, 0);
  assert.equal(mem.facts.length, 0);
});

test('consolidate: open_threads / blockers → ongoing 层', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.open_threads', value: { text: '还没配 CI secret' } },
    { op: 'add', path: 'suggested.blockers',     value: { text: '等待运维开权限' } },
  ], 4);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem);

  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 2);
  for (const f of alive) assert.equal(f.layer, 'ongoing');
  const tags = alive.map((f) => f.tags?.[0]).sort();
  assert.deepEqual(tags, ['blocker', 'thread']);
});

test('consolidate: status=resolved 的 open_thread / blocker 不入库', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.open_threads', value: { text: '闭合的线头', status: 'resolved' } },
    { op: 'add', path: 'suggested.open_threads', value: { text: '还活着的线头', status: 'wip' } },
  ], 1);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem);

  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.match(alive[0].text, /还活着/);
});

test('consolidate: custom.debug → facts + lesson tag', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: 'test 挂 → jest.setup.ts hook 泄漏' } },
  ], 6);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem);

  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.equal(alive[0].layer, 'facts');
  assert.deepEqual(alive[0].tags, ['lesson']);
});

test('consolidate: 未知 custom 命名空间 fallback，tag = namespace', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'custom.refactor.strategy', value: { text: '先抽公共，再改调用点' } },
  ], 1);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem);

  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.equal(alive[0].layer, 'facts');
  assert.deepEqual(alive[0].tags, ['refactor']);
});

test('consolidate: 二次巩固幂等 —— 复用 Jaccard 去重，不重复入库', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'suggested.findings', value: { text: 'staging.host:22 可通' } },
  ], 1);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem, 1000);
  const firstAlive = mem.facts.filter((f) => !f.superseded_by).length;
  assert.equal(firstAlive, 1);

  // 第二次调用（模拟 /consolidate 再按一遍，或 wrapping→closed 两次触发）
  const rep2 = consolidateLedgerToMemory(l, mem, 2000);
  assert.equal(rep2.merge.added.length, 0);
  assert.equal(rep2.merge.updated.length, 1);   // 命中 dedup 只刷新时间戳
  const secondAlive = mem.facts.filter((f) => !f.superseded_by).length;
  assert.equal(secondAlive, 1);
});

test('consolidate: 空账本 no-op', () => {
  const l = createEmptyLedger('s1');
  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  const rep = consolidateLedgerToMemory(l, mem);
  assert.equal(rep.candidates, 0);
  assert.equal(rep.merge.added.length, 0);
  assert.equal(mem.facts.length, 0);
});

test('consolidate: 条目 meta.confidence 覆盖默认', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    // meta.confidence = 0.99 应该覆盖 finding 默认的 0.85
    { op: 'add', path: 'suggested.findings', value: { text: 'x', meta: { confidence: '0.99' } } },
  ], 1);

  const store = new MemoryMemoryStore();
  const mem = store.load('u1');
  consolidateLedgerToMemory(l, mem);
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive[0].confidence, 0.99);
});
