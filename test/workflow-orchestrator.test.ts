import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { orchestrate, OrchestratorError } from '../src/workflow/orchestrator.ts';
import { MockLLM } from './mock-llm.ts';

const reg = buildDefaultRegistry();

const validGraphJson = JSON.stringify({
  thought: '先研究再写作',
  goal: '写一段 MCP 介绍',
  nodes: [
    { id: 'researcher', role: 'researcher', instruction: '调研 MCP', tools: ['web_search'] },
    { id: 'writer', role: 'writer', instruction: '基于 {{researcher.result}} 写作', depends_on: ['researcher'] },
  ],
  final: '{{writer.result}}',
});

test('orchestrate: 解析合法 graph JSON', async () => {
  const llm = new MockLLM();
  llm.enqueueText(validGraphJson);
  const { graph } = await orchestrate(llm, reg, { task: '写一段 MCP 介绍' });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].id, 'researcher');
  assert.equal(graph.final, '{{writer.result}}');
});

// 注:原来的"容忍代码围栏包裹""容忍前后多余文本"两条测试已删除 —— 编排器现在走
// complete() 的结构化输出(jsonSchema 约束解码),provider 保证返回纯 JSON,不再需要
// 从围栏/闲聊文本里抠 JSON。orchestrate 现在直接 JSON.parse(raw),非纯 JSON 一律抛错
// (见下面"无 JSON 抛错""花括号不平衡抛错")。

test('orchestrate: 缺少 goal 时用 task 兜底', async () => {
  const noGoal = JSON.stringify({ nodes: [{ id: 'a', role: 'r', instruction: 'do' }] });
  const llm = new MockLLM();
  llm.enqueueText(noGoal);
  const { graph } = await orchestrate(llm, reg, { task: '我的任务' });
  assert.equal(graph.goal, '我的任务');
});

test('orchestrate: 无 JSON 抛错', async () => {
  const llm = new MockLLM();
  llm.enqueueText('我不知道怎么做');
  await assert.rejects(() => orchestrate(llm, reg, { task: 'x' }), OrchestratorError);
});

test('orchestrate: 缺少 nodes 数组抛错', async () => {
  const llm = new MockLLM();
  llm.enqueueText(JSON.stringify({ goal: 'x' }));
  await assert.rejects(() => orchestrate(llm, reg, { task: 'x' }), /nodes/);
});

test('orchestrate: 花括号不平衡抛错', async () => {
  const llm = new MockLLM();
  llm.enqueueText('{ "nodes": [ ');
  await assert.rejects(() => orchestrate(llm, reg, { task: 'x' }), OrchestratorError);
});
