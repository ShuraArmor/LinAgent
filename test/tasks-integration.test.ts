import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { BackgroundTaskManager } from '../src/tasks/manager.ts';
import { MemoryTaskStore } from '../src/tasks/store.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';
import { toolResultPreview } from '../src/ui/render.ts';
import type { Tool } from '../src/types.ts';

const cfg = {
  ...DEFAULT_AGENT_CONFIG,
  maxTurns: 8,
  useLLMCompression: false,
  context: { maxMessages: 100, keepRecent: 8 },
};

// 假的 bash_exec（在 SPAWNABLE 白名单里），结算受 deferred 控制以模拟慢任务。
function makeSlowBash(resolveWith: unknown, gate: Promise<void>): Tool {
  return {
    name: 'bash_exec',
    description: 'fake slow bash',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: [], additionalProperties: true },
    handler: async () => { await gate; return resolveWith; },
  };
}

function regWith(tool: Tool): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool);
  return r;
}

test('集成: spawn_task 慢任务转后台，下一轮 chat 注入完成通知', async () => {
  let openGate!: () => void;
  const gate = new Promise<void>((res) => { openGate = res; });
  const registry = regWith(makeSlowBash({ exit_code: 0, stdout: 'ok' }, gate));

  const store = new MemoryTaskStore();
  const runner = async (tool: string, args: unknown, sessionId: string) =>
    registry.invoke(tool, args, { sessionId, sessionState: {}, logger: () => {} });
  const manager = new BackgroundTaskManager(runner, store);

  // 第一轮：agent 用 spawn_task 把 bash 丢后台（wait_ms=0 立即转后台），然后收尾。
  const llm = new MockLLM([
    toolCall('spawn_task', { tool: 'bash_exec', args: { command: 'sleep 100' }, label: '跑长命令', wait_ms: 0 }),
    finalAnswer('已经在后台跑了，稍后看结果'),
  ]);
  const agent = new Agent(llm, registry, cfg, undefined, undefined, undefined, manager);
  const mgr = new SessionManager();
  const s = mgr.create();

  const res1 = await agent.chat(s, '帮我在后台跑个长命令');
  assert.match(res1.finalAnswer, /后台/);
  // 任务此刻仍在后台跑
  assert.equal(manager.list(s.id, 'running').length, 1);

  // 后台任务完成
  openGate();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(manager.list(s.id, 'done').length, 1);

  // 第二轮：agent.chat 开头应把完成通知作为 system 消息注入 history。
  llm.enqueue(finalAnswer('看到后台任务完成了'));
  await agent.chat(s, '好了吗');

  const injected = s.history.filter(
    (m) => m.role === 'system' && /后台任务/.test(m.content) && /完成/.test(m.content),
  );
  assert.equal(injected.length, 1, '应注入恰好一条后台完成通知');
  assert.match(injected[0].content, /stdout/, '通知里应带结果');
});

test('集成: spawn_task 快任务在宽限期内完成，直接同步返回结果', async () => {
  const registry = regWith(makeSlowBash({ exit_code: 0, stdout: 'fast' }, Promise.resolve()));
  const store = new MemoryTaskStore();
  const runner = async (tool: string, args: unknown, sessionId: string) =>
    registry.invoke(tool, args, { sessionId, sessionState: {}, logger: () => {} });
  const manager = new BackgroundTaskManager(runner, store);

  const llm = new MockLLM([
    toolCall('spawn_task', { tool: 'bash_exec', args: { command: 'echo fast' }, label: '快命令', wait_ms: 1000 }),
    finalAnswer('done'),
  ]);
  const agent = new Agent(llm, registry, cfg, undefined, undefined, undefined, manager);
  const mgr = new SessionManager();
  const s = mgr.create();
  await agent.chat(s, 'x');

  // 快任务同步完成 → 不应留下 running 任务，且没有后续注入（结果已在 tool result 里）
  assert.equal(manager.list(s.id, 'running').length, 0);
  assert.equal(manager.list(s.id, 'done').length, 1);
});

test('回归: 后台完成通知 drain 出的 tool_result trace，REPL 渲染不崩', async () => {
  // 复现用户报的 "✗ 错误 [agent] Cannot read properties of undefined (reading 'slice')"：
  // drainCompleted 在 chat() 顶部（任何 try 之外）push 的 tool_result 形状是
  // { backgroundTask, status } —— 没有 result；旧 REPL 直接 JSON.stringify(d.result).slice 就炸，
  // 且异常冒到外层 catch 报成 [agent]。这里把 chat 的 onTrace 接上真实渲染 helper 验证不抛。
  let openGate!: () => void;
  const gate = new Promise<void>((res) => { openGate = res; });
  const registry = regWith(makeSlowBash({ exit_code: 0, stdout: 'ok' }, gate));
  const store = new MemoryTaskStore();
  const runner = async (tool: string, args: unknown, sessionId: string) =>
    registry.invoke(tool, args, { sessionId, sessionState: {}, logger: () => {} });
  const manager = new BackgroundTaskManager(runner, store);

  const llm = new MockLLM([
    toolCall('spawn_task', { tool: 'bash_exec', args: { command: 'sleep 100' }, label: '长命令', wait_ms: 0 }),
    finalAnswer('后台跑着'),
  ]);
  const agent = new Agent(llm, registry, cfg, undefined, undefined, undefined, manager);
  const s = new SessionManager().create();
  await agent.chat(s, '后台跑个命令');

  openGate();
  await new Promise((r) => setTimeout(r, 10));

  // 第二轮：模拟用户输入 "你全部运行"。onTrace 用真实渲染 helper——若渲染抛错，
  // 异常会从 onTrace（在 chat 顶部 drain 循环里、try 之外）冒出，测试即失败。
  llm.enqueue(finalAnswer('好的'));
  const rendered: string[] = [];
  await assert.doesNotReject(
    agent.chat(s, '你全部运行', {
      onTrace: (entry) => {
        if (entry.kind === 'tool_result') {
          const { name, preview } = toolResultPreview(
            entry.data as { name?: string; result?: unknown; backgroundTask?: string; status?: string },
          );
          rendered.push(`${name}:${preview}`);
        }
      },
    }),
  );
  // 应渲染出后台任务那条，且内容合理（不是崩溃兜底）。
  assert.ok(rendered.some((r) => /后台任务/.test(r) && /done/.test(r)), `实际渲染: ${rendered.join(' | ')}`);
});
