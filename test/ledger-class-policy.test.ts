import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveClass, classFromPresetName, compressionPolicyFor, recallBiasFor,
  featureOf, disposeOf, createEmptyLedger, applyPatches,
} from '../src/ledger/index.ts';
import type { Message } from '../src/types.ts';

test('classFromPresetName: 已知名直通，未知名落 default', () => {
  assert.equal(classFromPresetName('debug'), 'debug');
  assert.equal(classFromPresetName('execution'), 'execution');
  assert.equal(classFromPresetName('brainstorm'), 'brainstorm');
  assert.equal(classFromPresetName('default'), 'default');
  assert.equal(classFromPresetName('my-custom-preset'), 'default'); // 用户自定义 → 保守
  assert.equal(classFromPresetName(undefined), 'default');
});

test('resolveClass: 空账本 → default', () => {
  assert.equal(resolveClass(createEmptyLedger('s1')), 'default');
  assert.equal(resolveClass(undefined), 'default');
});

test('resolveClass: 账本有 debug 命名空间 → debug 类', () => {
  const l = createEmptyLedger('s1');
  l.core.intent = '排查报错';
  applyPatches(l, [
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: 'x→y→z' } },
  ], 3);
  assert.equal(resolveClass(l), 'debug');
});

test('resolveClass: intent 含执行关键词 → execution 类', () => {
  const l = createEmptyLedger('s1');
  l.core.intent = '帮我部署到 staging 并配置 CI';
  assert.equal(resolveClass(l), 'execution');
});

test('compressionPolicyFor: debug 保留证据、execution 删噪音', () => {
  const dbg = compressionPolicyFor('debug');
  assert.equal(dbg.dispose.tool_success, 'archive', 'debug 工具输出是证据，归档不删');
  assert.equal(dbg.dispose.tool_error, 'archive', 'debug 报错也归档');
  assert.ok(dbg.summaryFields.includes('custom.debug.causal_chain'), 'debug 摘要优先因果链');

  const exec = compressionPolicyFor('execution');
  assert.equal(exec.dispose.tool_success, 'delete', 'execution 成功输出是噪音，删');
  assert.equal(exec.dispose.tool_error, 'archive', 'execution 报错仍是证据，归档');
  assert.equal(exec.dispose.assistant_action, 'merge', 'execution 动作要点合并进摘要');
  assert.ok(exec.summaryFields[0].includes('progress'), 'execution 摘要优先 progress');
});

test('compressionPolicyFor: default 全归档、brainstorm 删推理', () => {
  const def = compressionPolicyFor('default');
  for (const f of ['user', 'assistant_action', 'assistant_reasoning', 'tool_error', 'tool_success'] as const) {
    assert.equal(def.dispose[f], 'archive', `default 下 ${f} 应保守归档`);
  }
  const bs = compressionPolicyFor('brainstorm');
  assert.equal(bs.dispose.assistant_reasoning, 'delete', 'brainstorm 推导可砍');
  assert.equal(bs.dispose.user, 'merge', 'brainstorm 用户观点合并');
});

test('featureOf: 消息 → 特征分类', () => {
  assert.equal(featureOf({ role: 'user', content: 'hi' }), 'user');
  assert.equal(featureOf({ role: 'assistant', content: '我想想', toolCalls: [] }), 'assistant_reasoning');
  assert.equal(featureOf({ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'x', args: {} }] }), 'assistant_action');
  assert.equal(featureOf({ role: 'tool', content: 'ok done', toolName: 'x' }), 'tool_success');
  assert.equal(featureOf({ role: 'tool', content: 'Error: boom', toolName: 'x' }), 'tool_error');
});

test('disposeOf: execution 下成功工具输出被删、报错被归档', () => {
  const exec = compressionPolicyFor('execution');
  const ok: Message = { role: 'tool', content: 'build succeeded', toolName: 'bash' };
  const err: Message = { role: 'tool', content: 'FAIL: 失败了', toolName: 'bash' };
  assert.equal(disposeOf(ok, exec), 'delete');
  assert.equal(disposeOf(err, exec), 'archive');
});

test('recallBiasFor: 各类别有不同的偏好层与特征词', () => {
  assert.ok(recallBiasFor('debug').boostKeywords.includes('根因'));
  assert.ok(recallBiasFor('execution').boostKeywords.includes('部署'));
  assert.deepEqual(recallBiasFor('default').boostKeywords, [], 'default 无偏置');
});
