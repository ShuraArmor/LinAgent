import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { BackgroundTaskManager } from '../src/tasks/manager.ts';
import { MemoryTaskStore } from '../src/tasks/store.ts';
import { taskTools } from '../src/tools/tasks.ts';
import { MockLLM, finalAnswer } from './mock-llm.ts';

/**
 * 异步任务"完成即自动唤醒 agent"的核心行为（Agent.resumeForTasks）。
 * 见 plan / [[linagent-async-wake]]。
 */

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * 造一个带后台任务能力的 agent。runner 挂一个 deferred —— 测试显式 resolve 才结算，
 * 这样 spawn(grace=0) 必定先转后台（status:running），再由 resolveTask() 触发完成。
 */
function agentWithTasks(runnerResult: unknown = 'bg-result') {
  const reg = new ToolRegistry();
  for (const t of taskTools) reg.register(t);
  const store = new MemoryTaskStore();
  const d = deferred<unknown>();
  const mgr = new BackgroundTaskManager(async () => d.promise, store);
  const llm = new MockLLM();
  const agent = new Agent(llm, reg, cfg, undefined, undefined, undefined, mgr);
  const resolveTask = async () => { d.resolve(runnerResult); await new Promise((r) => setTimeout(r, 5)); };
  return { agent, mgr, llm, resolveTask };
}

test('resumeForTasks: 后台任务完成后，无需用户消息即可注入结果并跑一轮', async () => {
  const { agent, mgr, llm, resolveTask } = agentWithTasks('测试通过');
  const s = new SessionManager().create();

  // 手动起一个后台任务（立即转后台），并等它结算。
  const r = await mgr.spawn(s.id, 'bash_exec', { cmd: 'test' }, '跑测试', 0);
  assert.equal(r.status, 'running');
  await resolveTask();

  // agent 醒来处理（不带用户消息）
  llm.enqueue(finalAnswer('测试已通过，无需进一步操作。'));
  const res = await agent.resumeForTasks(s);

  assert.ok(res.turns > 0, '唤醒轮应真正跑了一轮');
  // 历史里应有注入的任务结果（system）+ agent 的回复（assistant），但没有 user 消息
  assert.ok(s.history.some((m) => m.role === 'system' && /跑测试/.test(m.content)), '结果被注入');
  assert.ok(!s.history.some((m) => m.role === 'user'), '唤醒轮不该有用户消息');
  assert.match(res.finalAnswer, /测试已通过/);
});

test('resumeForTasks: 没有未投递的完成任务 → no-op，不调 LLM', async () => {
  const { agent, llm } = agentWithTasks();
  const s = new SessionManager().create();
  const res = await agent.resumeForTasks(s);
  assert.equal(res.turns, 0, '无任务应 no-op');
  assert.equal(llm.calls.length, 0, '不该调 LLM');
  assert.equal(s.history.length, 0, '不该动历史');
});

test('resumeForTasks: 完成的任务只注入一次（幂等）', async () => {
  const { agent, mgr, llm, resolveTask } = agentWithTasks('r');
  const s = new SessionManager().create();
  await mgr.spawn(s.id, 'bash_exec', {}, 'x', 0);
  await resolveTask();

  llm.enqueue(finalAnswer('处理完毕'));
  await agent.resumeForTasks(s);
  const systemCount1 = s.history.filter((m) => m.role === 'system').length;

  // 再唤醒一次 —— 该任务已 delivered，不该再注入
  const res2 = await agent.resumeForTasks(s);
  assert.equal(res2.turns, 0, '第二次唤醒无新任务 → no-op');
  const systemCount2 = s.history.filter((m) => m.role === 'system').length;
  assert.equal(systemCount2, systemCount1, '任务结果没有被重复注入');
});

test('resumeForTasks: agent 可自主选择静默收尾（不强制长回复）', async () => {
  const { agent, mgr, llm, resolveTask } = agentWithTasks('ok');
  const s = new SessionManager().create();
  await mgr.spawn(s.id, 'bash_exec', {}, 'x', 0);
  await resolveTask();

  // agent 给一句极简收尾 —— 落实"自己判断"，不硬编码播报
  llm.enqueue(finalAnswer('好'));
  const res = await agent.resumeForTasks(s);
  assert.equal(res.finalAnswer, '好', 'agent 可短收尾');
});

test('resumeForTasks: 大结果被截断注入，不撑爆上下文', async () => {
  const big = 'x'.repeat(10000);
  const { agent, mgr, llm, resolveTask } = agentWithTasks(big);
  const s = new SessionManager().create();
  await mgr.spawn(s.id, 'bash_exec', {}, '大输出', 0);
  await resolveTask();

  llm.enqueue(finalAnswer('收到'));
  await agent.resumeForTasks(s);
  const injected = s.history.find((m) => m.role === 'system' && /大输出/.test(m.content));
  assert.ok(injected, '有注入');
  assert.match(injected!.content, /已截断/, '大结果应被截断');
  assert.ok(injected!.content.length < big.length, '注入长度远小于原始结果');
});
