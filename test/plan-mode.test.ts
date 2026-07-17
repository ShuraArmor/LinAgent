import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM, finalAnswer } from './mock-llm.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';

// 统一后的 Agent：plan 只是一个决策模式（session.state.planMode），
// 不再是独立的 V2Agent。这些测试锁定"同一个 agent 两种模式"的契约。

function planJson(plan: object): string {
  return JSON.stringify(plan);
}

test('plan 模式：开启后 Agent 走规划-执行，产出 plan/spans/metrics', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      thought: 'weather → todo',
      steps: [
        { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' }, expect: 'result.available == true' },
        { id: 's2', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'bring umbrella' }, depends_on: ['s1'] },
        { id: 'final', kind: 'respond', template: 'Beijing: {{s1.result.condition}}. Todo #{{s2.result.added.id}}.' },
      ],
    }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const s = new SessionManager().create();
  s.state.planMode = true;

  const res = await agent.chat(s, 'check Beijing weather and add a todo');

  assert.ok(res.plan, 'plan 模式应产出 plan');
  assert.ok(res.spans && res.spans.length > 0, 'plan 模式应产出 spans');
  assert.ok(res.planMetrics, 'plan 模式应产出 planMetrics');
  assert.equal(res.planMetrics!.planner_calls, 1, '2 工具的 plan 只需 1 次 planner 调用');
  assert.match(res.finalAnswer, /Beijing: Sunny with clouds/);
  assert.equal((s.state.todos as { items: unknown[] }).items.length, 1);
});

test('loop 模式：关闭 planMode 时走 ReAct，不产出 plan/spans', async () => {
  const llm = new MockLLM();
  llm.enqueue(finalAnswer('直接回答')); // 无工具调用 = 最终答复
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const s = new SessionManager().create();
  // planMode 未设置 → 默认 loop

  const res = await agent.chat(s, 'hi');

  assert.equal(res.plan, undefined, 'loop 模式不产出 plan');
  assert.equal(res.spans, undefined, 'loop 模式不产出 spans');
  assert.equal(res.planMetrics, undefined, 'loop 模式不产出 planMetrics');
  assert.equal(res.finalAnswer, '直接回答');
});

test('两模式共用同一 session：plan 模式产物写进同一 history', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'calculator', args: { expression: '2+2' } },
        { id: 'final', kind: 'respond', template: 'ans={{s1.result}}' },
      ],
    }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const s = new SessionManager().create();
  s.state.planMode = true;

  const before = s.history.length;
  await agent.chat(s, '2+2');
  assert.ok(s.history.length > before, 'plan 模式把 user/assistant 消息写进同一 session.history');
  const last = s.history[s.history.length - 1];
  assert.equal(last.role, 'assistant', '最后一条是 assistant 答复');
});
