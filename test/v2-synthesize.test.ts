import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM } from './mock-llm.ts';
import { buildDefaultRegistry, ToolRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { V2Agent } from '../src/v2/agent.ts';
import { executePlan } from '../src/v2/executor.ts';
import { verifyPlan } from '../src/v2/verifier.ts';
import type { Plan } from '../src/v2/plan.ts';
import type { Tool } from '../src/types.ts';

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
    synthesize: async (input) => {
      observedKeys = Object.keys(input.outputs).sort();
      return 'synthesized-answer';
    },
    userInput: 'test',
  });
  assert.equal(res.answer, 'synthesized-answer');
  assert.deepEqual(observedKeys, ['a', 'c'], 'synthesizer should only see referenced outputs');
});

test('v2 agent: synthesize plan makes exactly 2 LLM calls (planner + synth)', async () => {
  // Planner emits a plan whose respond uses synthesize=true; synthesizer is a plain llm.chat call.
  const llm = new MockLLM();
  // 1) planner reply — a plan
  llm.enqueue(JSON.stringify({
    thought: 'compare 2 cities',
    steps: [
      { id: 'a', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 'b', kind: 'tool', tool: 'weather', args: { city: 'Shenzhen' } },
      { id: 'final', kind: 'respond', synthesize: true,
        template: 'Compare {{a.result}} and {{b.result}} — which is hotter?' },
    ],
  }));
  // 2) synthesizer reply — plain text
  llm.enqueue('Shenzhen is hotter (33°C vs 33°C same; ties allowed).');

  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'which is hotter, Beijing or Shenzhen?');

  assert.equal(res.metrics.planner_calls, 1);
  assert.equal(res.metrics.synth_calls, 1);
  assert.equal(res.metrics.llm_calls, 2);
  assert.match(res.answer, /Shenzhen/);
});

test('v2 agent: without synthesize, no synth call happens (baseline)', async () => {
  const llm = new MockLLM([
    JSON.stringify({
      steps: [
        { id: 'a', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
        { id: 'final', kind: 'respond',
          template: 'Beijing: {{a.result.condition}}' },
      ],
    }),
  ]);
  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'beijing weather?');
  assert.equal(res.metrics.synth_calls, 0);
  assert.equal(res.metrics.llm_calls, 1);
});
