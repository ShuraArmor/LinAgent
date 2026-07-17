import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { verifyPlan, PlanVerifyError } from '../src/plan/verifier.ts';
import type { Plan } from '../src/plan/plan.ts';

const reg = buildDefaultRegistry();

const goodPlan: Plan = {
  thought: 'weather then todo',
  steps: [
    { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' },
      expect: 'result.available == true' },
    { id: 's2', kind: 'tool', tool: 'todo',
      args: { action: 'add', text: 'bring umbrella' }, depends_on: ['s1'] },
    { id: 'final', kind: 'respond',
      template: '{{s1.result.condition}} — added todo {{s2.result.added.id}}' },
  ],
};

test('verifier: accepts a valid plan and returns a topological order', () => {
  const { order } = verifyPlan(goodPlan, reg);
  assert.deepEqual(order, ['s1', 's2', 'final']);
});

test('verifier: rejects plan with no respond step', () => {
  const bad: Plan = { steps: [{ id: 's1', kind: 'tool', tool: 'weather', args: { city: 'Beijing' } }] };
  assert.throws(() => verifyPlan(bad, reg), PlanVerifyError);
});

test('verifier: rejects unknown tool', () => {
  const bad: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'nope', args: {} },
      { id: 'final', kind: 'respond', template: 'x' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /unknown tool/);
});

test('verifier: rejects args that violate tool schema (when no refs used)', () => {
  const bad: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'calculator', args: { expr: '1+1' } }, // wrong key
      { id: 'final', kind: 'respond', template: 'x' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /calculator|missing required/i);
});

test('verifier: skips arg-schema check when args contain a ref', () => {
  const p: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'search', args: { query: 'agent' } },
      { id: 's2', kind: 'tool', tool: 'calculator', args: { expression: '{{s1.result.results[0].title}}' } },
      { id: 'final', kind: 'respond', template: '{{s2.result.result}}' },
    ],
  };
  // Verifier should NOT throw on args validation — resolution is a runtime concern.
  assert.doesNotThrow(() => verifyPlan(p, reg));
});

test('verifier: detects cycles', () => {
  const bad: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'X' }, depends_on: ['s2'] },
      { id: 's2', kind: 'tool', tool: 'weather', args: { city: 'Y' }, depends_on: ['s1'] },
      { id: 'final', kind: 'respond', template: 'x' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /cycle/);
});

test('verifier: rejects refs to unknown step ids', () => {
  const bad: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'X' } },
      { id: 'final', kind: 'respond', template: '{{sNope.result.condition}}' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /unknown step/);
});

test('verifier: expect DSL syntax is checked', () => {
  const bad: Plan = {
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'X' }, expect: 'result. == 1' },
      { id: 'final', kind: 'respond', template: 'x' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /expect syntax/);
});

test('verifier: total_budget_ms sum check', () => {
  const bad: Plan = {
    total_budget_ms: 100,
    steps: [
      { id: 's1', kind: 'tool', tool: 'weather', args: { city: 'X' }, budget_ms: 90 },
      { id: 's2', kind: 'tool', tool: 'weather', args: { city: 'Y' }, budget_ms: 90 },
      { id: 'final', kind: 'respond', template: 'x' },
    ],
  };
  assert.throws(() => verifyPlan(bad, reg), /budget/);
});
