import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalExpect, parseExpect, ExpectParseError } from '../src/v2/expect.ts';

test('expect: primitive comparisons', () => {
  assert.equal(evalExpect('1 == 1', {}), true);
  assert.equal(evalExpect('1 != 2', {}), true);
  assert.equal(evalExpect('2 > 1 && 3 < 5', {}), true);
  assert.equal(evalExpect('!(1 == 2)', {}), true);
});

test('expect: path lookups on result', () => {
  const ctx = { result: { ok: true, items: [{ x: 3 }, { x: 4 }] } };
  assert.equal(evalExpect('result.ok == true', ctx), true);
  assert.equal(evalExpect('len(result.items) == 2', ctx), true);
  assert.equal(evalExpect('result.items[1].x > result.items[0].x', ctx), true);
});

test('expect: nested precedence and arithmetic', () => {
  const ctx = { result: { temperature: { low: 24, high: 33 } } };
  assert.equal(evalExpect('result.temperature.high - result.temperature.low > 5', ctx), true);
  assert.equal(evalExpect('result.temperature.high < 40 && result.temperature.low > 10', ctx), true);
});

test('expect: strings and negation', () => {
  const ctx = { result: { condition: 'Rain' } };
  assert.equal(evalExpect('result.condition == "Rain"', ctx), true);
  assert.equal(evalExpect('!(result.condition == "Snow")', ctx), true);
});

test('expect: parseExpect throws on syntax errors', () => {
  assert.throws(() => parseExpect('result. == 1'), ExpectParseError);
  assert.throws(() => parseExpect('1 + '), ExpectParseError);
});

test('expect: missing path resolves to undefined (compares as not-equal)', () => {
  const ctx = { result: { a: 1 } };
  assert.equal(evalExpect('result.missing == null', ctx), false); // undefined !== null
  assert.equal(evalExpect('result.missing != 1', ctx), true);
});
