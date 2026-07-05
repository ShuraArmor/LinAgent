import { test } from 'node:test';
import assert from 'node:assert/strict';
import { V2Agent } from '../src/v2/agent.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { MockLLM } from './mock-llm.ts';

function planJson(plan: object): string {
  return JSON.stringify(plan);
}

test('v2 approval: deny → step 记为失败，reflector 收到"用户拒绝"', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();

  const llm = new MockLLM([
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
  const agent = new V2Agent(llm, reg, {
    requireApproval: new Set(['fs_write']),
    approve: async () => 'deny',
  });
  const res = await agent.chat(s, '写一个文件');
  assert.match(res.answer, /拒绝/);
  assert.equal(res.metrics.reflector_calls, 1);
});

test('v2 approval: approve_session 让第二次同工具无需再问', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();

  // 用一个只做内存操作的工具避免落盘副作用
  const llm = new MockLLM([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'x' } },
        { id: 's2', kind: 'tool', tool: 'todo', args: { action: 'add', text: 'y' }, depends_on: ['s1'] },
        { id: 'final', kind: 'respond', template: 'done' },
      ],
    }),
  ]);
  let asked = 0;
  const agent = new V2Agent(llm, reg, {
    requireApproval: new Set(['todo']),
    approve: async () => { asked++; return 'approve_session'; },
  });
  await agent.chat(s, '加两个 todo');
  assert.equal(asked, 1, '只应被问一次 —— approve_session 让后续放行');
});

test('v2 approval: 未列入 requireApproval 的工具不触发审批', async () => {
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create();
  const llm = new MockLLM([
    planJson({
      steps: [
        { id: 's1', kind: 'tool', tool: 'calculator', args: { expression: '1+1' } },
        { id: 'final', kind: 'respond', template: '{{s1.result.result}}' },
      ],
    }),
  ]);
  let asked = 0;
  const agent = new V2Agent(llm, reg, {
    requireApproval: new Set(['fs_write']),
    approve: async () => { asked++; return 'deny'; },
  });
  const res = await agent.chat(s, '算算 1+1');
  assert.equal(asked, 0);
  assert.equal(res.answer, '2');
});
