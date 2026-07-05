/**
 * 回归测试：审批缓存必须能被 JSON 序列化 → 反序列化后仍然工作。
 * 之前的 bug：缓存是 Set，被 sessions.save 落盘时变成 {}，重启后 approved.has 崩溃。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG, type ApprovalDecision } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { V2Agent } from '../src/v2/agent.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

test('v1 approval 缓存 → JSON roundtrip → 仍然工作', async () => {
  // 第一轮：approve_session
  const llm1 = new MockLLM([
    toolCall('todo', { action: 'add', text: 'a' }),
    finalAnswer('ok1'),
  ]);
  const agent1 = new Agent(llm1, buildDefaultRegistry(), {
    ...cfg,
    requireApproval: new Set(['todo']),
    approve: async (): Promise<ApprovalDecision> => 'approve_session',
  });
  const mgr = new SessionManager();
  const s = mgr.create();
  await agent1.chat(s, '加一条 todo');

  // 模拟落盘 + 重启：把 state 走一遍 JSON
  s.state = JSON.parse(JSON.stringify(s.state));
  // approved 现在必然是 string[] 而不是 Set；如果代码错误地把它当 Set，就会崩
  assert.ok(Array.isArray(s.state.__approvedTools));
  assert.deepEqual(s.state.__approvedTools, ['todo']);

  // 第二轮：不应该再问审批
  let asked = 0;
  const llm2 = new MockLLM([
    toolCall('todo', { action: 'add', text: 'b' }),
    finalAnswer('ok2'),
  ]);
  const agent2 = new Agent(llm2, buildDefaultRegistry(), {
    ...cfg,
    requireApproval: new Set(['todo']),
    approve: async (): Promise<ApprovalDecision> => { asked++; return 'deny'; },
  });
  await agent2.chat(s, '再加一条');
  assert.equal(asked, 0, '会话已放行，不该再问');
});

test('v2 approval 缓存 → JSON roundtrip → 仍然工作', async () => {
  const planStep = JSON.stringify({
    steps: [
      { id: 's1', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'a' } },
      { id: 'final', kind: 'respond', template: 'done' },
    ],
  });
  const llm1 = new MockLLM([planStep]);
  const agent1 = new V2Agent(llm1, buildDefaultRegistry(), {
    requireApproval: new Set(['todo']),
    approve: async () => 'approve_session',
  });
  const mgr = new SessionManager();
  const s = mgr.create();
  await agent1.chat(s, 'go');

  s.state = JSON.parse(JSON.stringify(s.state));
  assert.ok(Array.isArray(s.state.__approvedTools));

  let asked = 0;
  const llm2 = new MockLLM([planStep]);
  const agent2 = new V2Agent(llm2, buildDefaultRegistry(), {
    requireApproval: new Set(['todo']),
    approve: async () => { asked++; return 'deny'; },
  });
  await agent2.chat(s, 'again');
  assert.equal(asked, 0);
});

test('损坏的 __approvedTools（非数组）不再崩，退化成"从头审批"', async () => {
  // 模拟旧数据把 Set 落盘变成 {} 的场景
  const mgr = new SessionManager();
  const s = mgr.create();
  s.state.__approvedTools = {} as unknown;  // 模拟坏数据

  let asked = 0;
  const llm = new MockLLM([
    toolCall('todo', { action: 'add', text: 'x' }),
    finalAnswer('ok'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), {
    ...cfg,
    requireApproval: new Set(['todo']),
    approve: async () => { asked++; return 'approve'; },
  });
  await assert.doesNotReject(() => agent.chat(s, 'go'));
  assert.equal(asked, 1, '坏数据 → 视作没缓存，重新问一次');
});
