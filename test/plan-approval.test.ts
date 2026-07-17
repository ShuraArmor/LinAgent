import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { MockLLM } from './mock-llm.ts';

/**
 * plan 模式下的工具审批行为（原 v2-approval.test.ts）。
 * v2 已合并：不再有 V2Agent，plan 是 Agent 的一个决策模式（session.state.planMode）。
 *   - requireApproval / approve 现在是 Agent 构造参数
 *   - res.answer      → res.finalAnswer
 *   - res.metrics.*   → res.planMetrics.*
 * 审批"approve_session"放行现在走进程内存（不落盘），但同一个 Agent 实例内多次
 * 调用仍应记住放行 —— 下面的测试逻辑不变。
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

test('plan approval: deny → step 记为失败，reflector 收到"用户拒绝"', async () => {
  const reg = buildDefaultRegistry();
  const s = planSession();

  const llm = new MockLLM();
  llm.enqueueTexts([
    // planner：想 fs_write（会被拒）
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'fs_write', args: { path: 'x.txt', content: 'x' } },
        { id: 'final', kind: 'respond', template: 'done' },
      ],
    }),
    // reflector：改成 respond，只回复"拒绝了"
    planJson({
      from_id: 's1',
      new_steps: [
        { id: 'final2', kind: 'respond', template: '被拒绝了' },
      ],
    }),
  ]);
  const agent = new Agent(llm, reg, {
    ...DEFAULT_AGENT_CONFIG,
    requireApproval: new Set(['fs_write']),
    approve: async () => 'deny',
  });
  const res = await agent.chat(s, '写一个文件');
  assert.match(res.finalAnswer, /拒绝/);
  assert.equal(res.planMetrics!.reflector_calls, 1);
});

test('plan approval: approve_session 让第二次同工具无需再问', async () => {
  const reg = buildDefaultRegistry();
  const s = planSession();

  // 用一个只做内存操作的工具避免落盘副作用
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'x' } },
        { id: 's2', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'y' }, depends_on: ['s1'] },
        { id: 'final', kind: 'respond', template: 'done' },
      ],
    }),
  ]);
  let asked = 0;
  const agent = new Agent(llm, reg, {
    ...DEFAULT_AGENT_CONFIG,
    requireApproval: new Set(['todo']),
    approve: async () => { asked++; return 'approve_session'; },
  });
  await agent.chat(s, '加两个 todo');
  assert.equal(asked, 1, '只应被问一次 —— approve_session 让后续放行');
});

test('plan approval: 未列入 requireApproval 的工具不触发审批', async () => {
  const reg = buildDefaultRegistry();
  const s = planSession();
  const llm = new MockLLM();
  llm.enqueueTexts([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'calculator', args: { expression: '1+1' } },
        { id: 'final', kind: 'respond', template: '{{s1.result.result}}' },
      ],
    }),
  ]);
  let asked = 0;
  const agent = new Agent(llm, reg, {
    ...DEFAULT_AGENT_CONFIG,
    requireApproval: new Set(['fs_write']),
    approve: async () => { asked++; return 'deny'; },
  });
  const res = await agent.chat(s, '算算 1+1');
  assert.equal(asked, 0);
  assert.equal(res.finalAnswer, '2');
});
