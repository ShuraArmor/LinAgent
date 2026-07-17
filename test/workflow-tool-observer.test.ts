import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { buildRunWorkflowTool, type WorkflowObserver } from '../src/tools/workflow.ts';
import { MockLLM, finalAnswer } from './mock-llm.ts';
import type { ToolContext } from '../src/types.ts';

const ctx: ToolContext = { sessionId: 't', sessionState: {}, logger: () => {} };

function graphJson() {
  return JSON.stringify({
    goal: '演示',
    nodes: [
      { id: 'a', role: 'worker', instruction: '做 A' },
      { id: 'b', role: 'worker', instruction: '做 B' },
    ],
    final: '{{a.result}} | {{b.result}}',
  });
}

test('run_workflow 工具: observer 生命周期钩子按序触发', async () => {
  const llm = new MockLLM();
  llm.enqueueText(graphJson());          // 编排器输出图(走 complete)
  llm.enqueue(finalAnswer('A 完成'));     // 子 agent a(走 chat)
  llm.enqueue(finalAnswer('B 完成'));     // 子 agent b(走 chat)

  const events: string[] = [];
  const observer: WorkflowObserver = {
    onGraphReady: (g) => events.push(`ready:${g.nodes.length}`),
    onNodeStart: (n) => events.push(`start:${n.id}`),
    onNodeDone: (o) => events.push(`done:${o.id}:${o.ok}`),
    onNodeSkipped: (id) => events.push(`skip:${id}`),
    onFinish: (r) => events.push(`finish:${r.metrics.node_count}`),
  };

  const tool = buildRunWorkflowTool({ llm, registry: buildDefaultRegistry(), observer });
  const result = await tool.handler({ task: '演示' }, ctx) as { ok: boolean; answer: string };

  assert.equal(result.ok, true);
  // onGraphReady 必须最先、onFinish 必须最后
  assert.equal(events[0], 'ready:2');
  assert.equal(events[events.length - 1], 'finish:2');
  // 两个节点都 start 且 done
  assert.ok(events.includes('start:a'));
  assert.ok(events.includes('start:b'));
  assert.ok(events.includes('done:a:true'));
  assert.ok(events.includes('done:b:true'));
});

test('run_workflow 工具: 无 observer 时也正常执行', async () => {
  const llm = new MockLLM();
  llm.enqueueText(graphJson());          // 编排器输出图(走 complete)
  llm.enqueue(finalAnswer('A'));         // 子 agent a(走 chat)
  llm.enqueue(finalAnswer('B'));         // 子 agent b(走 chat)
  const tool = buildRunWorkflowTool({ llm, registry: buildDefaultRegistry() });
  const result = await tool.handler({ task: 'x' }, ctx) as { ok: boolean };
  assert.equal(result.ok, true);
});
