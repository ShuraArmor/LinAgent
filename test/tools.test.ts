import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { evaluateExpression } from '../src/tools/calculator.ts';
import { ToolValidationError, ToolNotFoundError } from '../src/tools/registry.ts';

function ctx(state: Record<string, unknown> = {}) {
  return { sessionId: 'test', sessionState: state, logger: () => {} };
}

test('calculator: basic arithmetic + precedence', () => {
  assert.equal(evaluateExpression('1+2*3'), 7);
  assert.equal(evaluateExpression('(1+2)*3'), 9);
  assert.equal(evaluateExpression('2^10'), 1024);
  assert.equal(evaluateExpression('-3 + 5'), 2);
  assert.equal(evaluateExpression('10 % 3'), 1);
});

test('calculator: rejects division by zero', () => {
  assert.throws(() => evaluateExpression('1/0'), /Division by zero/);
});

test('calculator: rejects unbalanced parens', () => {
  assert.throws(() => evaluateExpression('(1+2'), /Mismatched/);
});

test('calculator: rejects bad chars', () => {
  assert.throws(() => evaluateExpression('1 + foo'), /Unexpected/);
});

test('registry: validates required args', async () => {
  const reg = buildDefaultRegistry();
  await assert.rejects(
    () => reg.invoke('calculator', {}, ctx()),
    ToolValidationError,
  );
});

test('registry: validates arg types', async () => {
  const reg = buildDefaultRegistry();
  await assert.rejects(
    () => reg.invoke('calculator', { expression: 42 }, ctx()),
    ToolValidationError,
  );
});

test('registry: unknown tool → ToolNotFoundError', async () => {
  const reg = buildDefaultRegistry();
  await assert.rejects(() => reg.invoke('nope', {}, ctx()), ToolNotFoundError);
});

test('search: returns hits for known keywords', async () => {
  const reg = buildDefaultRegistry();
  const out = (await reg.invoke('search', { query: 'typescript', top_k: 2 }, ctx())) as {
    results: Array<{ title: string }>;
  };
  assert.ok(out.results.length >= 1);
  assert.ok(out.results[0].title.toLowerCase().includes('typescript'));
});

test('search: empty on nonsense', async () => {
  const reg = buildDefaultRegistry();
  const out = (await reg.invoke('search', { query: 'zzzznonsense' }, ctx())) as { results: unknown[] };
  assert.equal(out.results.length, 0);
});

test('weather: known city in celsius', async () => {
  const reg = buildDefaultRegistry();
  const out = (await reg.invoke('weather', { city: 'Beijing' }, ctx())) as {
    available: boolean;
    temperature: { unit: string; low: number; high: number };
  };
  assert.equal(out.available, true);
  assert.equal(out.temperature.unit, 'C');
  assert.equal(out.temperature.high, 33);
});

test('weather: chinese name', async () => {
  const reg = buildDefaultRegistry();
  const out = (await reg.invoke('weather', { city: '上海' }, ctx())) as { available: boolean };
  assert.equal(out.available, true);
});

test('weather: fahrenheit conversion', async () => {
  const reg = buildDefaultRegistry();
  const out = (await reg.invoke('weather', { city: 'Beijing', unit: 'f' }, ctx())) as {
    temperature: { unit: string; high: number };
  };
  assert.equal(out.temperature.unit, 'F');
  assert.equal(out.temperature.high, Math.round(33 * 9 / 5 + 32));
});

test('weather: unknown city surfaces available=false', async () => {
  const reg = buildDefaultRegistry();
  const out = (await reg.invoke('weather', { city: 'Atlantis' }, ctx())) as { available: boolean };
  assert.equal(out.available, false);
});

test('todo: add/list/done/remove roundtrip', async () => {
  const reg = buildDefaultRegistry();
  const state = {};
  await reg.invoke('todo', { action: 'add', text: 'write tests' }, ctx(state));
  await reg.invoke('todo', { action: 'add', text: 'ship it' }, ctx(state));
  const list1 = (await reg.invoke('todo', { action: 'list' }, ctx(state))) as {
    items: Array<{ id: number; text: string; done: boolean }>;
  };
  assert.equal(list1.items.length, 2);
  await reg.invoke('todo', { action: 'done', id: 1 }, ctx(state));
  const list2 = (await reg.invoke('todo', { action: 'list' }, ctx(state))) as {
    items: Array<{ id: number; done: boolean }>;
  };
  assert.equal(list2.items[0].done, true);
  await reg.invoke('todo', { action: 'remove', id: 2 }, ctx(state));
  const list3 = (await reg.invoke('todo', { action: 'list' }, ctx(state))) as { items: unknown[] };
  assert.equal(list3.items.length, 1);
});

test('todo: invalid enum action rejected by schema', async () => {
  const reg = buildDefaultRegistry();
  await assert.rejects(
    () => reg.invoke('todo', { action: 'launch' }, ctx()),
    ToolValidationError,
  );
});
