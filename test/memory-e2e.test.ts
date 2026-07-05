import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MemoryMemoryStore } from '../src/memory.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

test('memory e2e: session 2 sees identity/preferences injected without keyword match', async () => {
  const store = new MemoryMemoryStore();
  const reg = buildDefaultRegistry();

  // Session 1 — seed a mix of layers
  const llm1 = new MockLLM([
    finalAnswer('好，记住了。'),
    JSON.stringify({
      facts: [
        { layer: 'identity',    text: '住在杭州', confidence: 0.95 },
        { layer: 'preferences', text: '回复用中文', confidence: 0.95 },
        { layer: 'facts',       text: '喜欢喝咖啡', confidence: 0.9 },
      ],
    }),
  ]);
  await new Agent(llm1, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '记住：我住杭州，回复用中文，喜欢喝咖啡。');
  const alive = store.load('default').facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 3);

  // Session 2 — query has NO keyword overlap with any stored fact.
  // Identity + preferences must still be injected (always-on).
  // The unrelated `facts` layer entry ("喜欢喝咖啡") must NOT be injected.
  const llm2 = new MockLLM([finalAnswer('ok'), JSON.stringify({ facts: [] })]);
  await new Agent(llm2, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '你还记得关于我的什么吗？');
  const sys = llm2.calls[0].find((m) => m.role === 'system')?.content ?? '';
  assert.match(sys, /住在杭州/,     'identity is always injected');
  assert.match(sys, /回复用中文/,   'preferences is always injected');
  assert.doesNotMatch(sys, /喜欢喝咖啡/, 'facts-layer entries are keyword-gated');
});

test('memory e2e: keyword-matched facts pulled in when query mentions them', async () => {
  const store = new MemoryMemoryStore();
  const reg = buildDefaultRegistry();
  // Seed a facts-layer entry
  const llm1 = new MockLLM([
    finalAnswer('好'),
    JSON.stringify({ facts: [{ layer: 'facts', text: '喜欢喝咖啡' }] }),
  ]);
  await new Agent(llm1, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '我喜欢咖啡');

  // Now ask something that overlaps
  const llm2 = new MockLLM([finalAnswer('ok'), JSON.stringify({ facts: [] })]);
  await new Agent(llm2, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '推荐一款咖啡豆吧');
  const sys = llm2.calls[0].find((m) => m.role === 'system')?.content ?? '';
  assert.match(sys, /喜欢喝咖啡/);
});

test('memory e2e: contradiction — session 2 supersedes an old identity fact', async () => {
  const store = new MemoryMemoryStore();
  const reg = buildDefaultRegistry();

  // Session 1: seed "lives in Beijing"
  const llm1 = new MockLLM([
    finalAnswer('好，记住了。'),
    JSON.stringify({ facts: [{ layer: 'identity', text: '住在北京' }] }),
  ]);
  await new Agent(llm1, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '我住北京');

  // Session 2: user moves — extractor flags contradiction
  const llm2 = new MockLLM([
    finalAnswer('了解，你搬家了。'),
    JSON.stringify({
      facts: [{ layer: 'identity', text: '住在上海', contradicts: '住在北京' }],
    }),
  ]);
  await new Agent(llm2, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '我搬到上海了');

  const mem = store.load('default');
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 1);
  assert.match(alive[0].text, /上海/);
  // Old fact is still on disk with an audit trail.
  const stale = mem.facts.find((f) => f.superseded_by);
  assert.ok(stale);
  assert.match(stale!.text, /北京/);
});

test('memory e2e: user says "forget X" via the memory tool → fact goes stale', async () => {
  const store = new MemoryMemoryStore();
  const reg = buildDefaultRegistry();

  // Seed a fact
  const seed = store.load('default');
  seed.facts.push({
    id: 'f1', layer: 'facts', text: '喜欢橘猫', confidence: 1,
    created_at: 0, last_seen_at: 0, source: { session: 'x', turn: 0 },
  });
  seed.next_id = 2;
  store.save(seed);

  // Agent tool_call → memory(forget, id="f1") → final
  const llm = new MockLLM([
    toolCall('memory', { action: 'forget', id: 'f1' }),
    finalAnswer('已经忘掉了。'),
    // Extractor
    JSON.stringify({ facts: [] }),
  ]);
  const agent = new Agent(llm, reg, cfg, { store, userId: 'default' });
  await agent.chat(new SessionManager().create(), '忘掉我喜欢橘猫这件事');

  const mem = store.load('default');
  const alive = mem.facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 0);
});

test('memory e2e: no memory config → memory tool errors out cleanly', async () => {
  const reg = buildDefaultRegistry();
  const llm = new MockLLM([
    toolCall('memory', { action: 'list' }),
    finalAnswer('抱歉，我没配置 memory'),
  ]);
  const agent = new Agent(llm, reg, cfg /* no memory */);
  const res = await agent.chat(new SessionManager().create(), '有什么关于我的记忆吗？');
  // Loop should recover: tool errors get fed back as tool_result, then finalAnswer gets set.
  const errs = res.trace.filter((t) => t.kind === 'error' && (t.data as { where: string }).where === 'tool');
  assert.equal(errs.length, 1);
  assert.match((errs[0].data as { message: string }).message, /no memory store configured/);
});

test('memory e2e: disableIngest skips extractor call', async () => {
  const store = new MemoryMemoryStore();
  const reg = buildDefaultRegistry();
  const llm = new MockLLM([finalAnswer('ok')]);
  const agent = new Agent(llm, reg, cfg, {
    store, userId: 'default', disableIngest: true,
  });
  await agent.chat(new SessionManager().create(), 'hi');
  // Exactly ONE LLM call — no extractor call.
  assert.equal(llm.calls.length, 1);
});
