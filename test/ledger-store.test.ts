import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryLedgerStore, FileLedgerStore,
  createEmptyLedger, applyPatches,
  normalizeLedger,
} from '../src/ledger/index.ts';

test('MemoryLedgerStore: 空 load 不污染 loadAll', () => {
  const s = new MemoryLedgerStore();
  const l = s.load('s1');
  assert.equal(l.session_id, 's1');
  assert.equal(l.core.intent, '');
  // 未 save 时 loadAll 不应该看见
  assert.equal(s.loadAll().length, 0);
});

test('MemoryLedgerStore: save 后可 loadAll', () => {
  const s = new MemoryLedgerStore();
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'replace', path: 'core.intent', value: '测试' },
  ], 1);
  s.save(l);
  const all = s.loadAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].core.intent, '测试');
});

test('FileLedgerStore: JSON roundtrip 后所有字段完整', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-ledger-'));
  try {
    const s = new FileLedgerStore(dir);
    const l = createEmptyLedger('s1');
    applyPatches(l, [
      { op: 'replace', path: 'core.intent', value: '部署项目' },
      { op: 'add', path: 'suggested.findings', value: { text: 'staging 通了' } },
      { op: 'add', path: 'custom.debug.causal_chain', value: { text: 'A→B→C' } },
    ], 5);
    l.turn_count = 5;
    l.updated_at = Date.now();
    s.save(l);

    // 存在文件
    assert.ok(existsSync(join(dir, 's1.json')));

    // 重新加载 —— 应该看到同样的内容
    const reloaded = s.load('s1');
    assert.equal(reloaded.session_id, 's1');
    assert.equal(reloaded.core.intent, '部署项目');
    assert.equal(reloaded.suggested.findings!.length, 1);
    assert.equal(reloaded.suggested.findings![0].text, 'staging 通了');
    assert.equal(reloaded.custom['debug.causal_chain'].length, 1);
    assert.equal(reloaded.custom['debug.causal_chain'][0].text, 'A→B→C');
    assert.equal(reloaded.turn_count, 5);
    assert.equal(reloaded.next_item_id, l.next_item_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileLedgerStore: load 不存在的 session 返回空账本，不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-ledger-'));
  try {
    const s = new FileLedgerStore(dir);
    const l = s.load('never-existed');
    assert.equal(l.session_id, 'never-existed');
    assert.equal(l.core.intent, '');
    // 不应该在磁盘上创建文件
    assert.equal(existsSync(join(dir, 'never-existed.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileLedgerStore: loadAll 扫全库', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-ledger-'));
  try {
    const s = new FileLedgerStore(dir);
    for (const sid of ['a', 'b', 'c']) {
      const l = createEmptyLedger(sid, 'zh', 1000 + sid.charCodeAt(0));
      applyPatches(l, [
        { op: 'replace', path: 'core.intent', value: `intent-${sid}` },
      ], 1);
      s.save(l);
    }
    const all = s.loadAll();
    assert.equal(all.length, 3);
    // 按 created_at 排序
    assert.deepEqual(all.map((l) => l.session_id), ['a', 'b', 'c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileLedgerStore: 损坏文件返回空账本，不 throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-ledger-'));
  try {
    // 手写一个非法 JSON
    writeFileSync(join(dir, 'corrupt.json'), '{"bad": json here', 'utf8');
    const s = new FileLedgerStore(dir);
    // 单次 load —— 兜底成空账本
    const l = s.load('corrupt');
    assert.equal(l.core.intent, '');
    // loadAll —— 静默跳过
    const all = s.loadAll();
    assert.equal(all.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeLedger: 缺字段的老账本兜底补齐', () => {
  const partial = {
    session_id: 's1',
    core: { intent: 'x' },     // 缺 state / language
    suggested: {
      findings: [{ id: 'f7', text: 'y', created_turn: 1 }],
    },
    custom: {},
  } as any;
  const norm = normalizeLedger(partial, 's1');
  assert.equal(norm.core.state, 'active');
  assert.equal(norm.core.language, 'zh');
  assert.equal(norm.next_item_id, 8);   // 从 f7 推出下一个是 8
});

test('FileLedgerStore: session_id 里有非法路径字符时被清洗', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-ledger-'));
  try {
    const s = new FileLedgerStore(dir);
    const l = createEmptyLedger('has/slash');
    s.save(l);
    // 落盘的文件名应该被清洗过
    const files = readdirSync(dir);
    assert.ok(files.some((f: string) => !f.includes('/') && f.endsWith('.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
