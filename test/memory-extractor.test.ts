import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidates, extractFacts } from '../src/extractor.ts';
import { MockLLM } from './mock-llm.ts';

test('extractor: parses a well-formed JSON payload', () => {
  const raw = JSON.stringify({
    facts: [
      { layer: 'identity',    text: '住在杭州', confidence: 0.9 },
      { layer: 'preferences', text: '回复用中文' },
      { layer: 'ongoing',     text: '本周读 SICP', contradicts: '本周读 Go 圣经' },
    ],
  });
  const out = parseCandidates(raw);
  assert.equal(out.length, 3);
  assert.equal(out[0].layer, 'identity');
  assert.equal(out[0].confidence, 0.9);
  assert.equal(out[1].confidence, 0.8);         // default when omitted
  assert.equal(out[2].contradicts, '本周读 Go 圣经');
});

test('extractor: strips ```json fences', () => {
  const raw = '```json\n{"facts":[{"layer":"facts","text":"喜欢咖啡"}]}\n```';
  const out = parseCandidates(raw);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /咖啡/);
});

test('extractor: silently drops invalid entries (unknown layer, empty text, bad shape)', () => {
  const raw = JSON.stringify({
    facts: [
      { layer: 'identity', text: '住在杭州' },        // ok
      { layer: 'nonsense', text: 'foo' },              // bad layer
      { layer: 'facts',    text: '' },                 // empty
      'not-an-object',                                 // wrong shape
      { text: 'no layer' },                            // missing layer
    ],
  });
  const out = parseCandidates(raw);
  assert.equal(out.length, 1);
});

test('extractor: bad json returns empty (never throws, never partial)', () => {
  assert.deepEqual(parseCandidates('not json at all'), []);
  assert.deepEqual(parseCandidates('{"facts": '), []);
  assert.deepEqual(parseCandidates(''), []);
});

test('extractor: end-to-end with mock LLM', async () => {
  const llm = new MockLLM([
    JSON.stringify({
      facts: [
        { layer: 'identity',    text: '住在杭州' },
        { layer: 'preferences', text: '回复用中文' },
      ],
    }),
  ]);
  const res = await extractFacts(llm, 'user: 我住杭州，用中文回我\nassistant: 好的。');
  assert.equal(res.candidates.length, 2);
});

test('extractor: LLM error surfaces as zero facts (fail-safe over fail-loud)', async () => {
  const llm = new MockLLM([() => { throw new Error('boom'); }]);
  const res = await extractFacts(llm, 'anything');
  assert.equal(res.candidates.length, 0);
});
