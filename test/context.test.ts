import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/types.ts';
import { compressIfNeeded, heuristicSummarize } from '../src/context.ts';

function mkHistory(n: number): Message[] {
  const h: Message[] = [];
  for (let i = 0; i < n; i++) {
    h.push({ role: 'user', content: `question ${i}` });
    h.push({ role: 'assistant', content: `answer ${i}` });
  }
  return h;
}

test('context: no compression when under limit', async () => {
  const h = mkHistory(4); // 8 msgs
  const r = await compressIfNeeded(h, { maxMessages: 20, keepRecent: 4 }, heuristicSummarize);
  assert.equal(r.compressed, false);
  assert.equal(r.history.length, 8);
});

test('context: compresses when over limit and keeps recent tail', async () => {
  const h = mkHistory(10); // 20 msgs
  const r = await compressIfNeeded(
    h,
    { maxMessages: 12, keepRecent: 4 },
    heuristicSummarize,
  );
  assert.equal(r.compressed, true);
  // 1 summary + last 4 kept = 5
  assert.equal(r.history.length, 5);
  assert.equal(r.history[0].role, 'system');
  assert.match(r.history[0].content, /早期对话摘要/);
  // Tail should be the last 4 of the original list.
  assert.equal(r.history[r.history.length - 1].content, 'answer 9');
});

test('context: summarizer sees folded-out messages, not the tail', async () => {
  const h = mkHistory(6); // 12 msgs
  let seen: Message[] = [];
  await compressIfNeeded(
    h,
    { maxMessages: 8, keepRecent: 4 },
    (msgs) => { seen = msgs; return 'sum'; },
  );
  assert.equal(seen.length, 8);
  assert.equal(seen[0].content, 'question 0');
  // last folded item should be message 7 (index 7 → answer 3)
  assert.equal(seen[seen.length - 1].content, 'answer 3');
});
