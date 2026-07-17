import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM } from './mock-llm.ts';
import { buildDefaultRegistry, ToolRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { executePlan, type SynthesizeInput } from '../src/plan/executor.ts';
import { verifyPlan } from '../src/plan/verifier.ts';
import type { Plan } from '../src/plan/plan.ts';
import type { Tool } from '../src/types.ts';

/**
 * synthesize（综合器）行为（原 v2-synthesize.test.ts）。
 * - verifier: / executor: 纯函数测试 → 只改 import 路径（v2/→plan/），逻辑不动。
 * - plan agent: 集成测试 → V2Agent 迁移到 Agent + planMode。PlanMetrics 没有
 *   synth_calls/llm_calls；plan 模式下 planner 与 synthesizer 都走 llm.complete()，
 *   所以用 llm.completeCalls.length 精确保留"恰好 N 次 LLM 调用"这一原始意图。
 */
function planSession() {
  const s = new SessionManager().create();
  s.state.planMode = true;
  return s;
}

test('verifier: synthesize=true without refs is rejected', () => {
  const reg = buildDefaultRegistry();
  const bad: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 'final', kind: 'respond', synthesize: true,
        template: 'no refs at all' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /synthesize=true 但未引用任何前置步骤/);
});

test('verifier: empty template is rejected regardless of synthesize', () => {
  const reg = buildDefaultRegistry();
  const bad: Plan = {
    steps: [{ id: 'final', kind: 'respond', template: '' }],
  };
  assert.throws(() => verifyPlan(bad, reg), /empty template/);
});

test('executor: synthesize=true with no synthesizer configured → step fails cleanly', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const plan: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 'final', kind: 'respond', synthesize: true,
        template: 'What is the weather? {{s1.result}}' },
    ],
  };
  const res = await executePlan(plan, reg, s);
  assert.equal(res.failed_step, 'final');
  assert.match(res.failure_reason ?? '', /synthesize=true/);
});

test('executor: synthesizer receives only referenced step outputs', async () => {
  const reg = new ToolRegistry();
  const echo: Tool = {
    name: 'echo',
    description: 'echo the input',
    parameters: {
      type: 'object',
      properties: { v: { type: 'string' } },
      required: ['v'],
    },
    handler: (args) => ({ v: args.v }),
  };
  reg.register(echo);

  const mgr = new SessionManager();
  const s = mgr.create();
  const plan: Plan = {
    steps: [
      { id: 'a', kind: 'tool', tool: 'echo', args: { v: 'A' } },
      { id: 'b', kind: 'tool', tool: 'echo', args: { v: 'B' } },
      { id: 'c', kind: 'tool', tool: 'echo', args: { v: 'C' } },
      // final only references a and c — b should be omitted from synthesizer input
      { id: 'final', kind: 'respond', synthesize: true,
        template: 'pick from {{a.result}} and {{c.result}}' },
    ],
  };

  let observedKeys: string[] = [];
  const res = await executePlan(plan, reg, s, {
    synthesize: async (input: SynthesizeInput) => {
      observedKeys = Object.keys(input.outputs).sort();
      return 'synthesized-answer';
    },
    userInput: 'test',
  });
  assert.equal(res.answer, 'synthesized-answer');
  assert.deepEqual(observedKeys, ['a', 'c'], 'synthesizer should only see referenced outputs');
});

test('plan agent: synthesize plan makes exactly 2 LLM calls (planner + synth)', async () => {
  // Planner emits a plan whose respond uses synthesize=true; synthesizer is a plain llm.complete call.
  const llm = new MockLLM();
  // 1) planner reply — a plan(走 complete)
  llm.enqueueText(JSON.stringify({
    thought: 'compare 2 cities',
    steps: [
      { id: 'a', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 'b', kind: 'tool', tool: 'weather', args: { city: 'Shenzhen' } },
      { id: 'final', kind: 'respond', synthesize: true,
        template: 'Compare {{a.result}} and {{b.result}} — which is hotter?' },
    ],
  }));
  // 2) synthesizer reply — plain text(走 complete)
  llm.enqueueText('Shenzhen is hotter (33°C vs 33°C same; ties allowed).');

  const reg = buildDefaultRegistry();
  const agent = new Agent(llm, reg, DEFAULT_AGENT_CONFIG);
  const res = await agent.chat(planSession(), 'which is hotter, Beijing or Shenzhen?');

  assert.equal(res.planMetrics!.planner_calls, 1);
  // PlanMetrics 无 synth_calls/llm_calls；plan 模式 planner+synth 都走 complete()，
  // 恰好 2 次 LLM 调用 == completeCalls.length === 2（planner 1 + synth 1）。
  assert.equal(llm.completeCalls.length, 2);
  // synthesizer 确实被调用的证据：最终答复是 synth 产出的文本，而不是模板原文。
  assert.match(res.finalAnswer, /Shenzhen/);
});

test('plan agent: without synthesize, no synth call happens (baseline)', async () => {
  const llm = new MockLLM();
  llm.enqueueText(JSON.stringify({       // planner reply(走 complete)
    steps: [
      { id: 'a', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 'final', kind: 'respond',
        template: 'Beijing: {{a.result.condition}}' },
    ],
  }));
  const reg = buildDefaultRegistry();
  const agent = new Agent(llm, reg, DEFAULT_AGENT_CONFIG);
  const res = await agent.chat(planSession(), 'beijing weather?');
  assert.equal(res.planMetrics!.planner_calls, 1);
  // 无 synthesize → 只有 planner 一次 complete()，没有额外的 synth 调用。
  assert.equal(llm.completeCalls.length, 1);
  assert.match(res.finalAnswer, /Beijing:/);
});
