import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentOutput, ParseError } from '../src/llm/parser.ts';

test('parser: extracts a plain final_answer', () => {
  const out = parseAgentOutput('{"thought":"done","action":"final_answer","final_answer":"hi"}');
  assert.equal(out.action, 'final_answer');
  assert.equal(out.final, 'hi');
  assert.equal(out.thought, 'done');
});

test('parser: extracts a tool_call', () => {
  const raw = '{"thought":"need math","action":"tool_call","tool_name":"calculator","tool_args":{"expression":"1+1"}}';
  const out = parseAgentOutput(raw);
  assert.equal(out.action, 'tool_call');
  assert.equal(out.tool?.name, 'calculator');
  assert.deepEqual(out.tool?.args, { expression: '1+1' });
});

test('parser: strips ```json fences', () => {
  const raw = '```json\n{"action":"final_answer","final_answer":"ok"}\n```';
  const out = parseAgentOutput(raw);
  assert.equal(out.final, 'ok');
});

test('parser: tolerates leading prose before JSON', () => {
  const raw = 'Some intro text\n{"action":"final_answer","final_answer":"ok"}\ntrailing';
  const out = parseAgentOutput(raw);
  assert.equal(out.final, 'ok');
});

test('parser: handles nested braces and quoted strings', () => {
  const raw = '{"action":"tool_call","tool_name":"todo","tool_args":{"action":"add","text":"eat { food } now"}}';
  const out = parseAgentOutput(raw);
  assert.equal(out.tool?.name, 'todo');
  assert.equal((out.tool?.args as { text: string }).text, 'eat { food } now');
});

test('parser: rejects missing tool_name', () => {
  assert.throws(
    () => parseAgentOutput('{"action":"tool_call","tool_args":{}}'),
    ParseError,
  );
});

test('parser: rejects unknown action', () => {
  assert.throws(
    () => parseAgentOutput('{"action":"shrug"}'),
    ParseError,
  );
});

test('parser: rejects non-JSON', () => {
  assert.throws(() => parseAgentOutput('hello there'), ParseError);
});
