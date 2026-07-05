import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, maxTurns: 4, useLLMCompression: false };

test('streaming: onDelta receives chunks that reassemble to the full LLM output', async () => {
  const answer = finalAnswer('this is a longer answer to force multiple chunks');
  const llm = new MockLLM([answer]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();

  const chunks: string[] = [];
  const res = await agent.chat(s, 'hi', {
    onDelta: (chunk) => { chunks.push(chunk); },
  });
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  assert.equal(chunks.join(''), answer);
  assert.match(res.finalAnswer, /longer answer/);
});

test('streaming: onTurnStart fires once per turn', async () => {
  const llm = new MockLLM([
    toolCall('calculator', { expression: '1+1' }),
    finalAnswer('2'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();

  const turns: number[] = [];
  await agent.chat(s, 'add', { onTurnStart: (t) => turns.push(t) });
  assert.deepEqual(turns, [1, 2]);
});
