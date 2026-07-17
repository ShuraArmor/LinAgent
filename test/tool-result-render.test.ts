/**
 * 回归：REPL 的 tool_result 渲染曾对 `JSON.stringify(d.result).slice(0,120)` 无脑取值。
 * 两种情况会炸：
 *   1. 后台任务完成通知 push 的 data 是 { backgroundTask, status } —— 没有 result；
 *   2. 工具返回 undefined —— JSON.stringify(undefined) === undefined（不是字符串）。
 * 二者都会抛 "Cannot read properties of undefined (reading 'slice')"。
 * 因为这条 push 在 chat() 顶部、任何 try 之外，异常会冒到 REPL 外层 catch → 报 [agent]。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolResultPreview } from '../src/ui/render.ts';

test('普通工具结果：正常序列化 + 截断', () => {
  const { name, preview } = toolResultPreview({ name: 'calculator', result: { value: 2 } });
  assert.equal(name, 'calculator');
  assert.equal(preview, '{"value":2}');
});

test('工具返回 undefined：不抛错，兜底为 (无返回值)', () => {
  // 复现核心：JSON.stringify(undefined) === undefined
  assert.doesNotThrow(() => toolResultPreview({ name: 'noop', result: undefined }));
  const { preview } = toolResultPreview({ name: 'noop', result: undefined });
  assert.equal(preview, '(无返回值)');
});

test('后台任务完成通知形状 { backgroundTask, status }：不抛错', () => {
  assert.doesNotThrow(() => toolResultPreview({ backgroundTask: 'bg-1', status: 'done' }));
  const { name, preview } = toolResultPreview({ backgroundTask: 'bg-1', status: 'done' });
  assert.equal(name, '后台任务 bg-1');
  assert.equal(preview, '状态: done');
});

test('后台任务缺 status：兜底为 未知', () => {
  const { preview } = toolResultPreview({ backgroundTask: 'bg-2' });
  assert.equal(preview, '状态: 未知');
});

test('长结果按 max 截断', () => {
  const big = { s: 'x'.repeat(500) };
  const { preview } = toolResultPreview({ name: 't', result: big }, 50);
  assert.equal(preview.length, 50);
});
