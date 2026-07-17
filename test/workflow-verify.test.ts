import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { verifyGraph, GraphVerifyError } from '../src/workflow/verify.ts';
import type { WorkflowGraph } from '../src/workflow/types.ts';

const reg = buildDefaultRegistry();

const goodGraph: WorkflowGraph = {
  goal: '研究后写作',
  nodes: [
    { id: 'researcher', role: 'researcher', instruction: '调研 MCP 协议' },
    { id: 'writer', role: 'writer', instruction: '基于 {{researcher.result}} 写一段介绍', depends_on: ['researcher'] },
  ],
  final: '{{writer.result}}',
};

test('verifyGraph: 接受合法图并返回拓扑顺序', () => {
  const { order } = verifyGraph(goodGraph, reg);
  assert.deepEqual(order, ['researcher', 'writer']);
});

test('verifyGraph: 空图直接抛错', () => {
  assert.throws(() => verifyGraph({ goal: 'x', nodes: [] }, reg), GraphVerifyError);
});

test('verifyGraph: 重复节点 id', () => {
  const bad: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'r', instruction: 'do' },
      { id: 'a', role: 'r2', instruction: 'do2' },
    ],
  };
  assert.throws(() => verifyGraph(bad, reg), /重复的节点 id/);
});

test('verifyGraph: 缺少 role / instruction', () => {
  const bad = {
    goal: 'x',
    nodes: [{ id: 'a', role: '', instruction: '' }],
  } as WorkflowGraph;
  assert.throws(() => verifyGraph(bad, reg), GraphVerifyError);
});

test('verifyGraph: 悬空 depends_on', () => {
  const bad: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: 'do', depends_on: ['ghost'] }],
  };
  assert.throws(() => verifyGraph(bad, reg), /依赖未知节点 "ghost"/);
});

test('verifyGraph: instruction 引用未知节点', () => {
  const bad: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: '用 {{ghost.result}} 干活' }],
  };
  assert.throws(() => verifyGraph(bad, reg), /引用了未知节点 "ghost"/);
});

test('verifyGraph: 未知工具', () => {
  const bad: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: 'do', tools: ['nonexistent_tool'] }],
  };
  assert.throws(() => verifyGraph(bad, reg), /未知工具 "nonexistent_tool"/);
});

test('verifyGraph: final 模板引用未知节点', () => {
  const bad: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: 'do' }],
    final: '{{ghost.result}}',
  };
  assert.throws(() => verifyGraph(bad, reg), /final 模板引用了未知节点/);
});

test('verifyGraph: 环检测(a↔b 互相依赖)', () => {
  const bad: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'r', instruction: '用 {{b.result}}' },
      { id: 'b', role: 'r', instruction: '用 {{a.result}}' },
    ],
  };
  assert.throws(() => verifyGraph(bad, reg), /存在环/);
});

test('verifyGraph: 合法工具子集通过', () => {
  const ok: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: 'do', tools: ['calculator', 'weather'] }],
  };
  const { order } = verifyGraph(ok, reg);
  assert.deepEqual(order, ['a']);
});

test('verifyGraph: 三节点菱形依赖拓扑正确', () => {
  const g: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'r', instruction: 'start' },
      { id: 'b', role: 'r', instruction: '用 {{a.result}}' },
      { id: 'c', role: 'r', instruction: '用 {{a.result}}' },
      { id: 'd', role: 'r', instruction: '合并 {{b.result}} 和 {{c.result}}' },
    ],
  };
  const { order } = verifyGraph(g, reg);
  assert.equal(order[0], 'a');
  assert.equal(order[order.length - 1], 'd');
  assert.equal(order.length, 4);
});
