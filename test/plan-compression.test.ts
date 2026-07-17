import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { MockLLM } from './mock-llm.ts';

/**
 * plan 模式下的上下文压缩行为（原 v2-compression.test.ts）。
 * v2 已合并：plan 是 Agent 的一个决策模式（session.state.planMode）。
 * 压缩配置（context / useLLMCompression）现在是 Agent 构造参数，不再是 chat 的 opts。
 * context=null → 传 { maxMessages: Infinity } 显式关闭压缩（永不触发阈值）。
 */
function planJson(plan: object): string {
  return JSON.stringify(plan);
}

/** 起一个开了 plan 模式的会话。 */
function planSession() {
  const s = new SessionManager().create();
  s.state.planMode = true;
  return s;
}

test('plan compression: 长会话在进入 planner 前触发压缩', async () => {
  const reg = buildDefaultRegistry();
  const s = planSession();

  // 预先塞入 30 条老历史，模拟"长会话"
  for (let i = 0; i < 15; i++) {
    s.history.push({ role: 'user', content: `旧用户消息 ${i}` });
    s.history.push({ role: 'assistant', content: `旧助手回复 ${i}` });
  }
  assert.equal(s.history.length, 30);

  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [{ id: 'final', kind: 'respond', template: 'ok' }],
    }),
  ]);
  const agent = new Agent(llm, reg, {
    ...DEFAULT_AGENT_CONFIG,
    context: { maxMessages: 12, keepRecent: 4 },
    useLLMCompression: false,
  });
  await agent.chat(s, '第 16 次提问');

  // 触发压缩后：应当被折叠成 [摘要] + 最近 4 条 + 新用户 + 新 assistant = 7 条左右
  assert.ok(s.history.length < 30, `压缩后 history.length=${s.history.length}`);
  // 第一条应该是 system 摘要
  assert.equal(s.history[0].role, 'system');
  assert.match(s.history[0].content, /摘要/);
});

test('plan compression: 未超阈值时不触发', async () => {
  const reg = buildDefaultRegistry();
  const s = planSession();
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({ steps: [{ id: 'final', kind: 'respond', template: 'ok' }] }),
  ]);
  const agent = new Agent(llm, reg, {
    ...DEFAULT_AGENT_CONFIG,
    context: { maxMessages: 100, keepRecent: 20 },
    useLLMCompression: false,
  });
  await agent.chat(s, '你好');
  // history 不含 system 摘要
  assert.ok(!s.history.some((m) => m.role === 'system'));
});

test('plan compression: 阈值极大时显式关闭压缩', async () => {
  const reg = buildDefaultRegistry();
  const s = planSession();
  for (let i = 0; i < 20; i++) {
    s.history.push({ role: 'user', content: `msg ${i}` });
    s.history.push({ role: 'assistant', content: `reply ${i}` });
  }
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({ steps: [{ id: 'final', kind: 'respond', template: 'ok' }] }),
  ]);
  // 旧的 chat(s, m, { context: null }) 语义 → 阈值设为 Infinity，永不触发压缩
  const agent = new Agent(llm, reg, {
    ...DEFAULT_AGENT_CONFIG,
    context: { maxMessages: Infinity, keepRecent: 20 },
    useLLMCompression: false,
  });
  await agent.chat(s, '再问一句');
  // history 不应被折叠 —— 40 老 + 1 用户 + 1 助手 ≈ 42
  assert.ok(s.history.length >= 42, `history.length=${s.history.length}`);
});
