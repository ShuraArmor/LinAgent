import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryMemoryStore, FileMemoryStore,
  mergeCandidates, retrieveForQuery, formatForPrompt,
  forget, addManual,
} from '../src/memory.ts';

const src = { session: 's1', turn: 1 };

test('memory: dedup — near-identical facts refresh instead of stacking', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [{ layer: 'identity', text: '用户住在杭州' }], src, 1000);
  const r = mergeCandidates(mem, [{ layer: 'identity', text: '用户住在杭州' }], src, 2000);
  assert.equal(r.added.length, 0);
  assert.equal(r.updated.length, 1);
  assert.equal(mem.facts.filter((f) => !f.superseded_by).length, 1);
  assert.equal(mem.facts[0].last_seen_at, 2000);
});

test('memory: conflict — new identity fact supersedes old one via extractor hint', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [{ layer: 'identity', text: '用户住在北京' }], src, 1000);
  const r = mergeCandidates(mem, [
    { layer: 'identity', text: '用户住在上海', contradicts: '用户住在北京' },
  ], src, 2000);
  assert.equal(r.added.length, 1);
  assert.equal(r.superseded.length, 1);
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.match(alive[0].text, /上海/);
  // Old fact is on disk with an audit trail.
  const stale = mem.facts.find((f) => f.superseded_by);
  assert.ok(stale);
});

test('memory: conflict — identity layer auto-supersedes on strong overlap even without hint', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [{ layer: 'identity', text: '母语中文' }], src, 1000);
  mergeCandidates(mem, [{ layer: 'identity', text: '母语英文' }], src, 2000);
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.match(alive[0].text, /英文/);
});

test('memory: facts layer keeps multiple parallel entries (no auto-supersede)', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [
    { layer: 'facts', text: '喜欢喝咖啡' },
    { layer: 'facts', text: '喜欢弹吉他' },
    { layer: 'facts', text: '在读 SICP' },
  ], src, 1000);
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 3);
});

test('memory: retrieval — identity/preferences always come through, others keyword-matched', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [
    { layer: 'identity',    text: '住在杭州' },
    { layer: 'preferences', text: '回复用中文' },
    { layer: 'facts',       text: '喜欢喝咖啡' },
    { layer: 'facts',       text: '在做机器学习项目' },
    { layer: 'ongoing',     text: '本周读 SICP' },
  ], src, 1000);
  const hit = retrieveForQuery(mem, '给我推荐一本机器学习的书');
  const texts = hit.map((f) => f.text);
  assert.ok(texts.includes('住在杭州'));           // identity always
  assert.ok(texts.includes('回复用中文'));         // pref always
  assert.ok(texts.some((t) => t.includes('机器学习'))); // keyword matched
  assert.ok(!texts.includes('喜欢喝咖啡'), 'unrelated fact should not be pulled');
});

test('memory: formatForPrompt groups by layer', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [
    { layer: 'identity',    text: '住在杭州' },
    { layer: 'preferences', text: '回复用中文' },
  ], src, 1000);
  const out = formatForPrompt(mem.facts);
  assert.match(out, /identity:[\s\S]*住在杭州/);
  assert.match(out, /preferences:[\s\S]*回复用中文/);
});

test('memory: forget marks a fact stale, does not delete it', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  mergeCandidates(mem, [{ layer: 'facts', text: '喜欢橘猫' }], src, 1000);
  const id = mem.facts[0].id;
  forget(mem, id);
  assert.ok(mem.facts[0].superseded_by, 'still on disk with a marker');
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 0);
});

test('memory: addManual bypasses dedup and lands with confidence=1', () => {
  const store = new MemoryMemoryStore();
  const mem = store.load('u');
  const f = addManual(mem, 'preferences', '省略客套话', src, 1000);
  assert.equal(f.confidence, 1);
  assert.deepEqual(f.tags, ['user_asserted']);
});

test('memory: FileMemoryStore roundtrips through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-mem-'));
  try {
    const store1 = new FileMemoryStore(dir);
    const mem1 = store1.load('default');
    mergeCandidates(mem1, [{ layer: 'identity', text: '住在杭州' }], src, 1000);
    store1.save(mem1);

    const store2 = new FileMemoryStore(dir);
    const mem2 = store2.load('default');
    assert.equal(mem2.facts.length, 1);
    assert.match(mem2.facts[0].text, /杭州/);
    assert.equal(mem2.next_id, mem1.next_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: userId sanitization keeps files predictable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-mem-'));
  try {
    const store = new FileMemoryStore(dir);
    const mem = store.load('user/../etc/passwd');
    mergeCandidates(mem, [{ layer: 'identity', text: 'x' }], src, 1);
    store.save(mem);
    const { readdirSync } = await import('node:fs');
    const contents = readdirSync(dir);
    assert.equal(contents.length, 1);
    assert.match(contents[0], /^user_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
