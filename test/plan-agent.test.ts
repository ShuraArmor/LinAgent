import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM } from './mock-llm.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';

/**
 * plan 模式的规划-执行行为（原 v2-agent.test.ts）。
 * v2 已合并：不再有 V2Agent，plan 是 Agent 的一个决策模式（session.state.planMode）。
 *   - res.answer      → res.finalAnswer
 *   - res.metrics.*   → res.planMetrics.*（注意：PlanMetrics 没有 llm_calls/synth_calls，
 *                       用 planner_calls + reflector_calls 表示 LLM 调用次数）
 *   - chat(s,m,{maxReflections}) → config.planReflections
 */
function planJson(plan: object): string {
  return JSON.stringify(plan);
}

/** 起一个开了 plan 模式的会话。 */
function planSession() {
  const s = new SessionManager().create();
  s.state.planMode = true;
  return s;
}

test('plan: 两工具链只需 1 次 planner 调用', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      thought: 'weather → todo',
      steps: [
        { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' }, expect: 'result.available == true' },
        { id: 's2', kind: 'tool', tool: 'todo',
          args: { action: 'add', text: 'bring umbrella' }, depends_on: ['s1'] },
        { id: 'final', kind: 'respond',
          template: 'Beijing: {{s1.result.condition}}. Added todo #{{s2.result.added.id}}.' },
      ],
    }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const s = planSession();
  const res = await agent.chat(s, 'check Beijing weather and add a todo');

  assert.equal(res.planMetrics!.planner_calls, 1, '2 工具的 plan 只需 1 次 planner 调用');
  assert.equal(res.planMetrics!.reflector_calls, 0);
  assert.match(res.finalAnswer, /Beijing: Sunny with clouds/);
  assert.match(res.finalAnswer, /Added todo #1/);
  assert.equal((s.state.todos as { items: unknown[] }).items.length, 1);
});

test('plan: verifier 拒绝非法 plan，planner 重试', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'nonexistent', args: {} },
        { id: 'final', kind: 'respond', template: 'x' },
      ],
    }),
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'calculator', args: { expression: '2+2' } },
        { id: 'final', kind: 'respond', template: '{{s1.result.result}}' },
      ],
    }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const res = await agent.chat(planSession(), 'what is 2+2?');
  assert.equal(res.finalAnswer, '4');
  assert.equal(res.planMetrics!.planner_calls, 2);
  assert.equal(res.planMetrics!.verify_attempts, 2);
});

test('plan: reflector 修补 expect 失败的步骤', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Atlantis' },
          expect: 'result.available == true' },
        { id: 'final', kind: 'respond', template: '{{s1.result.condition}}' },
      ],
    }),
    planJson({
      thought: 'Atlantis is not in the mock table; try Beijing',
      from_id: 's1',
      new_steps: [
        { id: 's1b', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
        { id: 'final', kind: 'respond', template: 'Fell back to Beijing: {{s1b.result.condition}}' },
      ],
    }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const res = await agent.chat(planSession(), 'weather in Atlantis');
  assert.equal(res.planMetrics!.planner_calls, 1);
  assert.equal(res.planMetrics!.reflector_calls, 1);
  assert.match(res.finalAnswer, /Fell back to Beijing/);
});

test('plan: 纯对话 plan（无工具）也能跑', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({ steps: [{ id: 'final', kind: 'respond', template: 'Hello there.' }] }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const res = await agent.chat(planSession(), 'hi');
  assert.equal(res.finalAnswer, 'Hello there.');
  assert.equal(res.planMetrics!.planner_calls, 1);
});

test('plan: reflector 修不好时优雅放弃', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Atlantis' },
          expect: 'result.available == true' },
        { id: 'final', kind: 'respond', template: 'x' },
      ],
    }),
    planJson({
      from_id: 's1',
      new_steps: [
        { id: 's1b', kind: 'tool', tool: 'weather', args: { city: 'ElDorado' },
          expect: 'result.available == true' },
        { id: 'final', kind: 'respond', template: 'x' },
      ],
    }),
    planJson({
      from_id: 's1b',
      new_steps: [
        { id: 's1c', kind: 'tool', tool: 'weather', args: { city: 'Xanadu' },
          expect: 'result.available == true' },
        { id: 'final', kind: 'respond', template: 'x' },
      ],
    }),
  ]);
  // maxReflections 现在是 config.planReflections
  const agent = new Agent(llm, buildDefaultRegistry(), { ...DEFAULT_AGENT_CONFIG, planReflections: 2 });
  const res = await agent.chat(planSession(), 'weather in Atlantis');
  assert.match(res.finalAnswer, /没能完成这个请求|couldn't complete/);
  assert.equal(res.planMetrics!.reflector_calls, 2);
});

test('plan: planner 输出被截断（半截 JSON），下一次重试恢复', async () => {
  const llm = new MockLLM();
  llm.enqueueTexts([
    // 第 1 次：JSON 被截断（模拟 max_tokens 打断）—— 会抛 PlannerError
    '{"thought":"weather","steps":[{"id":"s1","kind":"tool","tool":"weather","args":{"city":"Bei',
    // 第 2 次：完整 plan
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'calculator', args: { expression: '1+1' } },
        { id: 'final', kind: 'respond', template: '{{s1.result.result}}' },
      ],
    }),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  const res = await agent.chat(planSession(), 'what is 1+1?');
  assert.equal(res.finalAnswer, '2', '截断后重试应恢复并产出正确答复');
  assert.equal(res.planMetrics!.planner_calls, 2, '截断那次也算一次 planner 调用');
});

test('plan: planner 连续截断超过重试上限，报清晰的截断错误', async () => {
  const llm = new MockLLM();
  // 3 次都返回半截 JSON（默认 planVerifyRetries=2 → 共 3 次尝试）
  llm.enqueueTexts([
    '{"steps":[{"id":"s1"',
    '{"steps":[{"id":"s1"',
    '{"steps":[{"id":"s1"',
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), DEFAULT_AGENT_CONFIG);
  // 连续截断超过重试上限 → 抛 PlannerError（由 REPL 层格式化展示）。
  // 错误信息应带"截断"提示，而不是裸的 Unexpected end of JSON input。
  await assert.rejects(
    agent.chat(planSession(), 'rewrite the whole project'),
    /截断|解析 JSON 失败/,
  );
  assert.equal(llm.completeCalls.length, 3, '默认应尝试 3 次 planner 调用');
});
