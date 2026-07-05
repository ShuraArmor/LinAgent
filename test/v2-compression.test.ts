import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Agent } from '../src/v2/agent.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { MockLLM } from './mock-llm.ts';

function planJson(plan: object): string {
  return JSON.stringify(plan);
}

test('v2 compression: 长会话在进入 planner 前触发压缩', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();

  // 预先塞入 30 条老历史，模拟"长会话"
  for (let i = 0; i < 15; i++) {
    s.history.push({ role: 'user', content: `旧用户消息 ${i}` });
    s.history.push({ role: 'assistant', content: `旧助手回复 ${i}` });
  }
  assert.equal(s.history.length, 30);

  const llm = new MockLLM([
    planJson({
      steps: [{ id: 'final', kind: 'respond', template: 'ok' }],
    }),
  ]);
  const agent = new V2Agent(llm, reg);
  await agent.chat(s, '第 16 次提问', {
    context: { maxMessages: 12, keepRecent: 4 },
    useLLMCompression: false,
  });

  // 触发压缩后：应当被折叠成 [摘要] + 最近 4 条 + 新用户 + 新 assistant = 7 条左右
  assert.ok(s.history.length < 30, `压缩后 history.length=${s.history.length}`);
  // 第一条应该是 system 摘要
  assert.equal(s.history[0].role, 'system');
  assert.match(s.history[0].content, /摘要/);
});

test('v2 compression: 未超阈值时不触发', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const llm = new MockLLM([
    planJson({ steps: [{ id: 'final', kind: 'respond', template: 'ok' }] }),
  ]);
  const agent = new V2Agent(llm, reg);
  await agent.chat(s, '你好', {
    context: { maxMessages: 100, keepRecent: 20 },
    useLLMCompression: false,
  });
  // history 不含 system 摘要
  assert.ok(!s.history.some((m) => m.role === 'system'));
});

test('v2 compression: context=null 显式关闭压缩', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  for (let i = 0; i < 20; i++) {
    s.history.push({ role: 'user', content: `msg ${i}` });
    s.history.push({ role: 'assistant', content: `reply ${i}` });
  }
  const llm = new MockLLM([
    planJson({ steps: [{ id: 'final', kind: 'respond', template: 'ok' }] }),
  ]);
  const agent = new V2Agent(llm, reg);
  await agent.chat(s, '再问一句', { context: null });
  // history 不应被折叠 —— 40 老 + 1 用户 + 1 助手 ≈ 42
  assert.ok(s.history.length >= 42, `history.length=${s.history.length}`);
});
