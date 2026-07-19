import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MemoryMemoryStore, addManual } from '../src/memory.ts';
import { buildRecallMemoryTool } from '../src/tools/recall-memory.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';
import type { MemoryStore } from '../src/memory.ts';

/**
 * 记忆系统 e2e（账本为核心重构后）：
 *   - identity/preferences → 会话首轮冻结进 system prompt（"每次都注入"层）
 *   - facts/ongoing → 不自动注入，agent 用 recall_memory 工具按需召回
 *   - 写入 → 账本 consolidate（会话闭合）+ memory 工具（显式）；extractor 已删
 * 冻结的 system prompt 保证会话内不变（保 provider 缓存）——见 memory-cache.test.ts。
 */

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

/** 直接给 store 播种一层 fact（不经 LLM，测注入/召回用）。 */
function seed(store: MemoryStore, layer: 'identity' | 'preferences' | 'facts' | 'ongoing', text: string) {
  const mem = store.load('default');
  addManual(mem, layer, text, { session: 'seed', turn: 0 }, Date.now());
  store.save(mem);
}

test('memory e2e: identity/preferences 首轮冻结进 system（与关键词无关）', async () => {
  const store = new MemoryMemoryStore();
  seed(store, 'identity', '住在杭州');
  seed(store, 'preferences', '回复用中文');
  seed(store, 'facts', '喜欢喝咖啡');   // facts 层不该进 system

  const llm = new MockLLM([finalAnswer('ok')]);
  await new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '你还记得关于我的什么吗？');

  const sys = llm.calls[0].find((m) => m.role === 'system')?.content ?? '';
  assert.match(sys, /住在杭州/,     'identity 每次都注入');
  assert.match(sys, /回复用中文/,   'preferences 每次都注入');
  assert.doesNotMatch(sys, /喜欢喝咖啡/, 'facts 层不进 system（改 recall_memory 按需查）');
});

test('memory e2e: facts 通过 recall_memory 工具按需召回', async () => {
  const store = new MemoryMemoryStore();
  seed(store, 'facts', '喜欢喝咖啡');
  const reg = buildDefaultRegistry();
  reg.register(buildRecallMemoryTool(store, 'default'));

  // agent 调 recall_memory 查"咖啡" → 命中；再 final
  const llm = new MockLLM([
    toolCall('recall_memory', { query: '咖啡' }),
    finalAnswer('给你推荐一款咖啡豆'),
  ]);
  const res = await new Agent(llm, reg, cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '推荐一款咖啡豆吧');

  // 工具结果里应含召回的 fact
  const toolResult = res.trace.find((t) => t.kind === 'tool_result'
    && (t.data as { name?: string }).name === 'recall_memory');
  assert.ok(toolResult, '应有 recall_memory 的结果');
  const result = (toolResult!.data as { result: { rendered: string; count: number } }).result;
  assert.equal(result.count, 1);
  assert.match(result.rendered, /喜欢喝咖啡/);
});

test('memory e2e: recall_memory 不命中返回空', () => {
  const store = new MemoryMemoryStore();
  seed(store, 'facts', '喜欢喝咖啡');
  const tool = buildRecallMemoryTool(store, 'default');
  const r = tool.handler({ query: '量子物理' }, { sessionId: 's', sessionState: {}, logger: () => {} }) as
    { ok: boolean; count: number; facts: unknown[] };
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(r.facts.length, 0);
});

test('memory e2e: 用户 "忘掉X" 走 memory 工具 → fact 变 stale', async () => {
  const store = new MemoryMemoryStore();
  const s = store.load('default');
  s.facts.push({
    id: 'f1', layer: 'facts', text: '喜欢橘猫', confidence: 1,
    created_at: 0, last_seen_at: 0, recall_count: 0, source: { session: 'x', turn: 0 },
  });
  s.next_id = 2;
  store.save(s);

  const llm = new MockLLM([
    toolCall('memory', { action: 'forget', id: 'f1' }),
    finalAnswer('已经忘掉了。'),
  ]);
  await new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), '忘掉我喜欢橘猫这件事');

  const alive = store.load('default').facts.filter((f) => !f.superseded_by);
  assert.equal(alive.length, 0);
});

test('memory e2e: 无 memory 配置 → memory 工具干净报错', async () => {
  const llm = new MockLLM([
    toolCall('memory', { action: 'list' }),
    finalAnswer('抱歉，我没配置 memory'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg /* no memory */);
  const res = await agent.chat(new SessionManager().create(), '有什么关于我的记忆吗？');
  const errs = res.trace.filter((t) => t.kind === 'error' && (t.data as { where: string }).where === 'tool');
  assert.equal(errs.length, 1);
  assert.match((errs[0].data as { message: string }).message, /no memory store configured/);
});

test('memory e2e: 不再有 extractor 自动抽取（每轮只 1 次 LLM 调用）', async () => {
  const store = new MemoryMemoryStore();
  const llm = new MockLLM([finalAnswer('ok')]);
  await new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' })
    .chat(new SessionManager().create(), 'hi');
  // 只有主循环 1 次 chat 调用；extractor 已删，complete() 不该被调用。
  assert.equal(llm.calls.length, 1, 'chat 调用 1 次');
  assert.equal(llm.completeCalls.length, 0, 'complete（旧 extractor 路径）0 次');
});
