/**
 * 回归测试：Agent.chat 的 hooks.onTrace 必须能收到每一步 trace 事件。
 * 之前的 bug：REPL 往 DEFAULT_AGENT_CONFIG.onTrace 上赋值，但 Agent 构造时
 * 用 spread 拷了一份配置，改单例根本传不到实例 —— 实时 trace 显示链路是断的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

test('agent hooks.onTrace 收到 user_input / tool_call / tool_result / final', async () => {
  const llm = new MockLLM([
    toolCall('calculator', { expression: '1+1' }),
    finalAnswer('结果是 2'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const s = new SessionManager().create();

  const kinds: string[] = [];
  await agent.chat(s, '算一下 1+1', {
    onTrace: (entry) => { kinds.push(entry.kind); },
  });

  // 至少应该看到这几种事件（可能还有其它，比如 llm_response）
  for (const expected of ['user_input', 'tool_call', 'tool_result', 'final']) {
    assert.ok(kinds.includes(expected), `期望看到 ${expected}，实际序列: ${kinds.join(', ')}`);
  }
});

test('hooks.onTrace 比 config.onTrace 优先，但两者都会被调（互不覆盖）', async () => {
  const llm = new MockLLM([finalAnswer('ok')]);
  const configCalls: string[] = [];
  const hookCalls: string[] = [];
  const agent = new Agent(llm, buildDefaultRegistry(), {
    ...cfg,
    onTrace: (entry) => configCalls.push(entry.kind),
  });
  const s = new SessionManager().create();
  await agent.chat(s, 'hi', {
    onTrace: (entry) => hookCalls.push(entry.kind),
  });

  // 两个 handler 都应该收到全部事件（数量应该一致）
  assert.equal(hookCalls.length, configCalls.length, 'hook 和 config 应看到同样多的事件');
  assert.ok(hookCalls.includes('final'));
  assert.ok(configCalls.includes('final'));
});

test('没传 hooks.onTrace 时不会崩，config.onTrace 依然工作（向后兼容）', async () => {
  const llm = new MockLLM([finalAnswer('ok')]);
  const configCalls: string[] = [];
  const agent = new Agent(llm, buildDefaultRegistry(), {
    ...cfg,
    onTrace: (entry) => configCalls.push(entry.kind),
  });
  const s = new SessionManager().create();
  await agent.chat(s, 'hi');
  assert.ok(configCalls.includes('final'));
});
