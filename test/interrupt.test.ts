/**
 * 打断功能：用户 Esc 时，agent 应中止在途 LLM 请求并正常收尾（不当成错误），
 * 且不把半截 assistant 回合塞进 history（避免破坏多轮回传结构）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';
import type { ChatRequest, AssistantTurn } from '../src/types.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 6 };

test('打断：LLM 调用途中 abort → 正常收尾（不报错），history 不留半截 assistant', async () => {
  const ctrl = new AbortController();
  // MockLLM 的 chat 是函数：流式吐几片后，检测到 signal.aborted 就抛 AbortError（模拟 fetch 断流）。
  const llm = new MockLLM([
    (req: ChatRequest): AssistantTurn => {
      // 主动触发打断：模拟用户在流式过程中按 Esc
      ctrl.abort(new Error('用户打断'));
      if (req.signal?.aborted) {
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      }
      return finalAnswer('本不该看到的完整回复');
    },
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const s = new SessionManager().create();
  const before = s.history.length;

  const res = await agent.chat(s, '写一篇很长的文章', { signal: ctrl.signal });

  assert.match(res.finalAnswer, /打断|interrupted/, '应是打断收尾，不是错误');
  assert.doesNotMatch(res.finalAnswer, /失败|error/i, '不应表现成 LLM 调用失败');
  // history 末条应是刚才的 user 输入，而非半截 assistant。
  assert.equal(s.history[s.history.length - 1].role, 'user', 'history 不该留半截 assistant 回合');
  assert.equal(s.history.length, before + 1, '只多了一条 user 消息');
});

test('打断：工具执行后置起 abort → 本轮工具结果保留，不再进下一轮 LLM', async () => {
  const ctrl = new AbortController();
  // 第一轮返回一个工具调用；工具跑完后我们（模拟用户）abort，agent 应在检查点收尾，不发第二轮。
  const llm = new MockLLM([
    toolCall('calculator', { expression: '1+1' }),
    // 若 agent 错误地进了第二轮，这个 finalAnswer 会被消费 —— 用它来反证。
    finalAnswer('第二轮不该发生'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), {
    ...cfg,
    // 借 onTrace 在工具结果落定后触发打断（模拟用户此刻按 Esc）。
    onTrace: (entry) => { if (entry.kind === 'tool_result') ctrl.abort(new Error('用户打断')); },
  });
  const s = new SessionManager().create();

  const res = await agent.chat(s, '算 1+1', { signal: ctrl.signal });

  assert.match(res.finalAnswer, /打断|interrupted/, '应打断收尾');
  // 工具结果这条 tool 消息应保留在 history（多轮回传结构完整，不留悬空 tool_call）。
  const roles = s.history.map((m) => m.role);
  assert.ok(roles.includes('tool'), '工具结果应保留在 history');
  // MockLLM 第二个回合不应被消费（chat 只被调用一次）。
  assert.equal(llm.calls.length, 1, 'agent 不应发起第二轮 LLM 调用');
});
