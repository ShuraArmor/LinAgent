import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLM } from './mock-llm.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { V2Agent } from '../src/v2/agent.ts';

/**
 * Helper: emit a plan JSON as the planner would.
 */
function planJson(plan: object): string {
  return JSON.stringify(plan);
}

test('v2 agent: single tool chain runs with ONE LLM call', async () => {
  const llm = new MockLLM([
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
  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'check Beijing weather and add a todo');

  assert.equal(res.metrics.llm_calls, 1, 'v2 uses exactly 1 LLM call for a 2-tool plan');
  assert.equal(res.metrics.reflector_calls, 0);
  assert.match(res.answer, /Beijing: Sunny with clouds/);
  assert.match(res.answer, /Added todo #1/);
  assert.equal((s.state.todos as { items: unknown[] }).items.length, 1);
});

test('v2 agent: verifier rejects malformed plan, planner retries', async () => {
  const llm = new MockLLM([
    // First: uses an unknown tool → verifier should reject
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'nonexistent', args: {} },
        { id: 'final', kind: 'respond', template: 'x' },
      ],
    }),
    // Second: valid plan
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'calculator', args: { expression: '2+2' } },
        { id: 'final', kind: 'respond', template: '{{s1.result.result}}' },
      ],
    }),
  ]);
  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'what is 2+2?');
  assert.equal(res.answer, '4');
  assert.equal(res.metrics.planner_calls, 2);
  assert.equal(res.metrics.verify_attempts, 2);
});

test('v2 agent: reflector patches a plan whose step fails an expect', async () => {
  const llm = new MockLLM([
    // First plan: weather for an unknown city; expect will fail
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Atlantis' },
          expect: 'result.available == true' },
        { id: 'final', kind: 'respond', template: '{{s1.result.condition}}' },
      ],
    }),
    // Reflector patch: swap in a valid city
    planJson({
      thought: 'Atlantis is not in the mock table; try Beijing',
      from_id: 's1',
      new_steps: [
        { id: 's1b', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
        { id: 'final', kind: 'respond', template: 'Fell back to Beijing: {{s1b.result.condition}}' },
      ],
    }),
  ]);
  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'weather in Atlantis');
  assert.equal(res.metrics.planner_calls, 1);
  assert.equal(res.metrics.reflector_calls, 1);
  assert.match(res.answer, /Fell back to Beijing/);
});

test('v2 agent: conversational-only plan (no tool) still works', async () => {
  const llm = new MockLLM([
    planJson({
      steps: [{ id: 'final', kind: 'respond', template: 'Hello there.' }],
    }),
  ]);
  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'hi');
  assert.equal(res.answer, 'Hello there.');
  assert.equal(res.metrics.llm_calls, 1);
});

test('v2 agent: gives up gracefully when reflector cannot fix', async () => {
  const llm = new MockLLM([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Atlantis' },
          expect: 'result.available == true' },
        { id: 'final', kind: 'respond', template: 'x' },
      ],
    }),
    // Every reflection also picks a bad city
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
  const reg = buildDefaultRegistry();
  const agent = new V2Agent(llm, reg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'weather in Atlantis', { maxReflections: 2 });
  assert.match(res.answer, /couldn't complete this request/);
  assert.equal(res.metrics.reflector_calls, 2);
});
