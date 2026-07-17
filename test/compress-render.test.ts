/**
 * 回归：压缩事件有两种 trace 形状（FIFO 摘要 vs 账本归档），
 * 旧 compressLine 只按 FIFO 取 folded/kept，账本路径命中就显示
 * "已压缩：折叠 undefined 条 → 摘要 + 保留最近 undefined 条"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressLine } from '../src/ui/render.ts';
import { stripAnsi } from '../src/ui/width.ts';

test('FIFO 形状 { folded, kept }：正常显示条数', () => {
  const s = stripAnsi(compressLine({ folded: 12, kept: 8 }));
  assert.match(s, /折叠 12 条/);
  assert.match(s, /保留最近 8 条/);
  assert.doesNotMatch(s, /undefined/);
});

test('账本归档形状 { archived, beforeTokens, afterTokens, savedPct }：显示 token 变化', () => {
  const s = stripAnsi(compressLine({ archived: 5, beforeTokens: 4000, afterTokens: 1200, savedPct: 70 }));
  assert.match(s, /归档 5 条/);
  assert.match(s, /4000→1200/);
  assert.match(s, /省 70%/);
  assert.doesNotMatch(s, /undefined/);
});

test('账本路径缺 savedPct：兜底为 0，不出现 undefined', () => {
  const s = stripAnsi(compressLine({ archived: 3, beforeTokens: 100, afterTokens: 50 }));
  assert.match(s, /省 0%/);
  assert.doesNotMatch(s, /undefined/);
});

test('FIFO 路径缺字段：兜底为 0，不出现 undefined', () => {
  const s = stripAnsi(compressLine({ folded: 4 }));
  assert.match(s, /折叠 4 条/);
  assert.match(s, /保留最近 0 条/);
  assert.doesNotMatch(s, /undefined/);
});

test('archived=0 也走账本分支（不误判成 FIFO）', () => {
  const s = stripAnsi(compressLine({ archived: 0, beforeTokens: 200, afterTokens: 200, savedPct: 0 }));
  assert.match(s, /归档 0 条/);
  assert.doesNotMatch(s, /undefined/);
});
