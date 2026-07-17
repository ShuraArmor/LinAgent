import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry, ToolRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { executePlan } from '../src/plan/executor.ts';
import type { Plan } from '../src/plan/plan.ts';
import type { Tool } from '../src/types.ts';

test('executor: runs a simple two-step chain and produces answer', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const plan: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' }, expect: 'result.available == true' },
      { id: 'final', kind: 'respond',
        template: 'Beijing {{s1.result.temperature.low}}-{{s1.result.temperature.high}}°{{s1.result.temperature.unit}}' },
    ],
  };
  const res = await executePlan(plan, reg, s);
  assert.equal(res.failed_step, undefined);
  assert.equal(res.answer, 'Beijing 24-33°C');
});

test('executor: independent steps run in parallel', async () => {
  // A special registry with a slow tool so we can measure.
  const reg = new ToolRegistry();
  const slow: Tool = {
    name: 'slow',
    description: 'sleep then echo',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'integer' },
        label: { type: 'string' },
      },
      required: ['ms', 'label'],
    },
    handler: async (args) => {
      const ms = args.ms as number;
      await new Promise((r) => setTimeout(r, ms));
      return { label: args.label, ms };
    },
  };
  reg.register(slow);

  const mgr = new SessionManager();
  const s = mgr.create();

  const plan: Plan = {
    steps: [
      { id: 'a', kind: 'tool', tool: 'slow', args: { ms: 150, label: 'A' } },
      { id: 'b', kind: 'tool', tool: 'slow', args: { ms: 150, label: 'B' } },
      { id: 'c', kind: 'tool', tool: 'slow', args: { ms: 150, label: 'C' } },
      { id: 'final', kind: 'respond',
        template: '{{a.result.label}}{{b.result.label}}{{c.result.label}}' },
    ],
  };
  const start = Date.now();
  const res = await executePlan(plan, reg, s, { maxConcurrency: 3 });
  const elapsed = Date.now() - start;
  assert.equal(res.answer, 'ABC');
  // Three ~150ms sleeps run in parallel should finish well under 3×150ms.
  assert.ok(elapsed < 350, `expected parallel < 350ms, got ${elapsed}ms`);
});

test('executor: expect failure marks the step failed and halts downstream', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const plan: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Atlantis' },
        expect: 'result.available == true' },
      { id: 's2', kind: 'tool', tool: 'todo',
        args: { action: 'add', text: '{{s1.result.condition}}' }, depends_on: ['s1'] },
      { id: 'final', kind: 'respond', template: 'x' },
    ],
  };
  const res = await executePlan(plan, reg, s);
  assert.equal(res.failed_step, 's1');
  assert.ok(res.failure_reason?.includes('expect'));
  // s2 must NOT have run.
  assert.equal(res.outcomes.s2, undefined);
});

test('executor: template refs into arg values resolve correctly', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const plan: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 's2', kind: 'tool', tool: 'todo',
        args: { action: 'add', text: 'weather in {{s1.result.city}} is {{s1.result.condition}}' },
        depends_on: ['s1'] },
      { id: 'final', kind: 'respond', template: 'todo #{{s2.result.added.id}}' },
    ],
  };
  const res = await executePlan(plan, reg, s);
  assert.equal(res.failed_step, undefined);
  const todo = (s.state.todos as { items: Array<{ text: string }> }).items[0];
  assert.match(todo.text, /Sunny with clouds/);
});

test('executor: spans form a parent tree under the plan span', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const plan: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } },
      { id: 'final', kind: 'respond', template: '{{s1.result.condition}}' },
    ],
  };
  const res = await executePlan(plan, reg, s);
  const planSpan = res.spans.find((sp) => sp.kind === 'plan');
  assert.ok(planSpan);
  // Spans are emitted twice (start + complete); count distinct ids.
  const stepChildren = new Set(
    res.spans.filter((sp) => sp.parent === planSpan!.id && sp.kind === 'step').map((sp) => sp.id),
  );
  assert.equal(stepChildren.size, 2);
});
