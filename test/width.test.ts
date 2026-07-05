import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, padEndCols, wrapCols, stripAnsi, truncateCols } from '../src/ui/width.ts';
import { finalBox } from '../src/ui/render.ts';

test('width: 半角字符每个 1 列', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('abc123'), 6);
});

test('width: CJK 汉字每个 2 列', () => {
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('中文abc'), 4 + 3);
});

test('width: ANSI 转义序列不计入宽度', () => {
  const s = '\x1b[31m你好\x1b[0m';
  assert.equal(displayWidth(s), 4);
});

test('width: 零宽字符不计入', () => {
  assert.equal(displayWidth('a​b'), 2);
});

test('padEndCols: 中英混合能对齐', () => {
  assert.equal(displayWidth(padEndCols('你好', 10)), 10);
  assert.equal(displayWidth(padEndCols('hi', 10)), 10);
  // 已经够宽 → 不变
  assert.equal(padEndCols('你好世界', 4), '你好世界');
});

test('wrapCols: 按列宽切分中文', () => {
  const lines = wrapCols('你好世界你好', 4);
  assert.deepEqual(lines, ['你好', '世界', '你好']);
});

test('wrapCols: 中英混合按列宽切分', () => {
  const lines = wrapCols('ab你好cd', 4);
  // 'ab' (2) + '你' (2) = 4 → 一行；剩余 '好cd'（2+2）→ '好c' 是 3 列<=4, 再加 'd' 就 4 列
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => displayWidth(l) <= 4));
  assert.equal(lines.join(''), 'ab你好cd');
});

test('truncateCols: 中文截断带省略号', () => {
  const s = truncateCols('你好世界你好世界', 6);
  assert.ok(displayWidth(s) <= 6);
  assert.ok(s.endsWith('…'));
});

test('stripAnsi 干净剥除', () => {
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
});

test('finalBox: 每一行的可见宽度完全对齐', () => {
  const box = finalBox('我可以调用以下工具：\n- calculator：计算算术表达式。\n- search：mock 检索\nhello world');
  const rows = box.split('\n');
  // 每一行剥掉 ANSI 后的显示宽度应该相同
  const widths = rows.map((r) => displayWidth(r));
  const first = widths[0];
  assert.ok(widths.every((w) => w === first),
    `框的每行宽度应一致；实际=${widths.join(',')} 行数=${rows.length}`);
});

test('finalBox: 超长中文会被自动折行', () => {
  const answer = '这是一段非常长的中文文本，'.repeat(20);
  const box = finalBox(answer);
  const rows = box.split('\n');
  // 至少 3 行（顶 + 若干 body + 底），且每行都在合理列宽内
  assert.ok(rows.length >= 4);
  const first = displayWidth(rows[0]);
  assert.ok(rows.every((r) => displayWidth(r) === first));
});
