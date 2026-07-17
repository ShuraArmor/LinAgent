import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryArchiveStore, FileArchiveStore, makeHandle, parseHandle,
} from '../src/ledger/index.ts';
import type { Message } from '../src/types.ts';

const msgs: Message[] = [
  { role: 'user', content: '这是第 1 条' },
  { role: 'assistant', content: '这是回复' },
  { role: 'tool', toolName: 'weather', content: '{"ok":true,"temp":20}' },
];

test('archive: makeHandle / parseHandle 往返', () => {
  assert.equal(makeHandle('seg1'), '@seg1');
  assert.equal(parseHandle('@seg1'), 'seg1');
  assert.equal(parseHandle('@seg42'), 'seg42');
  assert.equal(parseHandle('seg1'), null);         // 缺 @ 前缀
  assert.equal(parseHandle('@bogus'), null);        // 不匹配 seg\d+
  assert.equal(parseHandle('  @seg3  '), 'seg3');   // 允许两侧空白
});

test('MemoryArchiveStore: 首次归档产 @seg1，第二次 @seg2', () => {
  const s = new MemoryArchiveStore();
  const r1 = s.archive('sid1', msgs, 5);
  assert.equal(r1.segId, 'seg1');
  assert.equal(r1.handle, '@seg1');
  const r2 = s.archive('sid1', msgs, 10);
  assert.equal(r2.segId, 'seg2');
});

test('MemoryArchiveStore: 不同 session 各自独立编号', () => {
  const s = new MemoryArchiveStore();
  const a = s.archive('A', msgs, 1);
  const b = s.archive('B', msgs, 1);
  assert.equal(a.segId, 'seg1');
  assert.equal(b.segId, 'seg1');
});

test('MemoryArchiveStore: 归档消息是拷贝 —— 外部修改不影响归档', () => {
  const s = new MemoryArchiveStore();
  const input = [{ role: 'user' as const, content: 'orig' }];
  s.archive('s', input, 1);
  input[0].content = 'mutated';
  const seg = s.load('s', 'seg1');
  assert.ok(seg);
  assert.equal(seg!.messages[0].content, 'orig');
});

test('MemoryArchiveStore: listForSession 按 seg_id 排序', () => {
  const s = new MemoryArchiveStore();
  s.archive('sid', msgs, 1);
  s.archive('sid', msgs, 2);
  s.archive('sid', msgs, 3);
  const list = s.listForSession('sid');
  assert.deepEqual(list.map((r) => r.seg_id), ['seg1', 'seg2', 'seg3']);
});

test('MemoryArchiveStore: removeForSession 清掉所有段', () => {
  const s = new MemoryArchiveStore();
  s.archive('sid', msgs, 1);
  s.archive('sid', msgs, 2);
  s.archive('other', msgs, 1);
  const n = s.removeForSession('sid');
  assert.equal(n, 2);
  assert.equal(s.listForSession('sid').length, 0);
  assert.equal(s.listForSession('other').length, 1);
});

test('FileArchiveStore: JSON roundtrip 保完消息内容 + 工具名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-arch-'));
  try {
    const s = new FileArchiveStore(dir);
    const { segId } = s.archive('sid', msgs, 7);
    assert.equal(segId, 'seg1');
    const seg = s.load('sid', 'seg1');
    assert.ok(seg);
    assert.equal(seg!.messages.length, 3);
    assert.equal(seg!.messages[2].toolName, 'weather');
    assert.equal(seg!.turn_at_archive, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileArchiveStore: nextSegId 扫描已有文件 —— 重启后编号不冲突', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-arch-'));
  try {
    const s1 = new FileArchiveStore(dir);
    s1.archive('sid', msgs, 1);
    s1.archive('sid', msgs, 2);
    // 新实例（模拟重启）
    const s2 = new FileArchiveStore(dir);
    const r = s2.archive('sid', msgs, 3);
    assert.equal(r.segId, 'seg3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileArchiveStore: load 不存在的段返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-arch-'));
  try {
    const s = new FileArchiveStore(dir);
    assert.equal(s.load('sid', 'seg9'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FileArchiveStore: removeForSession 删物理文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-arch-'));
  try {
    const s = new FileArchiveStore(dir);
    s.archive('sid', msgs, 1);
    s.archive('sid', msgs, 2);
    const n = s.removeForSession('sid');
    assert.equal(n, 2);
    assert.equal(existsSync(join(dir, 'sid-seg1.json')), false);
    assert.equal(existsSync(join(dir, 'sid-seg2.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
