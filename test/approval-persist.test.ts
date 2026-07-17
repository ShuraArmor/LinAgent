/**
 * 审批放行的持久化语义测试。
 *
 * 语义变更（安全修复）：审批"approve_session"放行现在是 **Agent 实例的进程内存**
 * （按 sessionId 存的私有 Map，见 src/agent.ts 的 sessionApprovals），**不再写进
 * session.state.__approvedTools、也不落盘**。原因：避免用户几天前点过"允许"、下次
 * 打开这个会话时危险工具被静默执行。__approvedTools 字段已从源码彻底移除。
 *
 * 因此原来"JSON roundtrip 后放行仍生效"的两个测试前提已不成立 —— 现改为验证
 * 新语义：放行不落盘、不跨 Agent 实例，roundtrip + 新实例后必须重新审批。
 * loop 模式(v1)和 plan 模式(原 v2)各测一遍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG, type ApprovalDecision } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

test('v1(loop 模式) 审批放行不落盘 → roundtrip + 新 Agent 实例 → 重新审批', async () => {
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

  // 放行走进程内存，不写进 session.state —— 落盘后不该出现 __approvedTools。
  assert.equal(s.state.__approvedTools, undefined, '放行不再写进 session.state');

  // 模拟落盘 + 重启：把 state 走一遍 JSON
  s.state = JSON.parse(JSON.stringify(s.state));

  // 第二轮：换一个新的 Agent 实例（模拟重启）→ 进程内存里的放行已丢失 → 必须重新审批
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
  assert.equal(asked, 1, '放行不跨实例/不落盘 → 新实例重新询问一次');
});

test('v2(plan 模式) 审批放行不落盘 → roundtrip + 新 Agent 实例 → 重新审批', async () => {
  const planStep = JSON.stringify({
    steps: [
      { id: 's1', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'a' } },
      { id: 'final', kind: 'respond', template: 'done' },
    ],
  });
  const planSession = () => {
    const s = new SessionManager().create();
    s.state.planMode = true;
    return s;
  };

  // plan 模式的 planner 走 llm.complete()，计划 JSON 进 text 队列。
  const llm1 = new MockLLM();
  llm1.enqueueText(planStep);
  const agent1 = new Agent(llm1, buildDefaultRegistry(), {
    ...DEFAULT_AGENT_CONFIG,
    requireApproval: new Set(['todo']),
    approve: async () => 'approve_session',
  });
  const s = planSession();
  await agent1.chat(s, 'go');

  assert.equal(s.state.__approvedTools, undefined, '放行不再写进 session.state');

  s.state = JSON.parse(JSON.stringify(s.state));

  let asked = 0;
  const llm2 = new MockLLM();
  llm2.enqueueText(planStep);
  // 新实例重新审批时返回 deny → 步骤失败 → 触发 reflector，需再给一份 reflect 回复
  // （改成纯 respond，收尾"被拒绝了"）。
  llm2.enqueueText(JSON.stringify({
    from_id: 's1',
    new_steps: [{ id: 'final2', kind: 'respond', template: '被拒绝了' }],
  }));
  const agent2 = new Agent(llm2, buildDefaultRegistry(), {
    ...DEFAULT_AGENT_CONFIG,
    requireApproval: new Set(['todo']),
    approve: async () => { asked++; return 'deny'; },
  });
  await agent2.chat(s, 'again');
  assert.equal(asked, 1, '放行不跨实例/不落盘 → 新实例重新询问一次');
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
