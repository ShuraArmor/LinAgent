import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = {
  ...DEFAULT_AGENT_CONFIG,
  maxTurns: 8,
  useLLMCompression: false,
  context: { maxMessages: 100, keepRecent: 8 },
};

test('agent: direct answer without a tool call', async () => {
  const llm = new MockLLM([finalAnswer('hello there')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'hi');
  assert.equal(res.finalAnswer, 'hello there');
  assert.equal(res.turns, 1);
  assert.equal(llm.calls.length, 1);
});

test('agent: single tool loop → calculator → final', async () => {
  const llm = new MockLLM([
    toolCall('calculator', { expression: '(3+4)*2' }, 'need math'),
    finalAnswer('14'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'what is (3+4)*2?');
  assert.equal(res.finalAnswer, '14');
  assert.equal(res.turns, 2);
  const kinds = res.trace.map((t) => t.kind);
  assert.deepEqual(kinds, [
    'user_input',
    'llm_response',
    'tool_call',
    'tool_result',
    'llm_response',
    'final',
  ]);
});

test('agent: chained tools (weather → todo → final)', async () => {
  const llm = new MockLLM([
    toolCall('weather', { city: 'Beijing' }),
    toolCall('todo', { action: 'add', text: 'bring umbrella?' }),
    finalAnswer('Beijing is 24-33°C, sunny with clouds. Todo added.'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'check weather in Beijing and record a todo');
  assert.equal(res.turns, 3);
  const state = s.state.todos as { items: unknown[] } | undefined;
  assert.equal(state?.items.length, 1);
  assert.ok(res.finalAnswer.includes('Beijing'));
});

test('agent: tool validation error is fed back and the loop recovers', async () => {
  const llm = new MockLLM([
    toolCall('calculator', { expr: 'oops' }),         // wrong key → validation error
    toolCall('calculator', { expression: '2+2' }),    // corrected
    finalAnswer('4'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'compute 2+2');
  assert.equal(res.finalAnswer, '4');
  // First tool call must have produced an error in the trace.
  const err = res.trace.find((t) => t.kind === 'error' && (t.data as { where: string }).where === 'tool');
  assert.ok(err, 'expected a tool error in trace');
});

// 注：原来的"unparsable output 自修"测试已删除 —— 原生工具调用协议下，
// 模型输出由 provider 的约束解码保证结构合法，不再有"抠 JSON 失败 → 回喂 user 让它自修"
// 这条路径（parser.ts 已删）。工具参数不合 schema 的情况由 validation error 作为
// tool result 回传处理，见上一条测试。

test('agent: enforces maxTurns', async () => {
  const llm = new MockLLM();
  // Keep calling calculator forever — every reply is another tool call.
  for (let i = 0; i < 20; i++) llm.enqueue(toolCall('calculator', { expression: '1+1' }));
  const agent = new Agent(llm, buildDefaultRegistry(), {
    ...cfg,
    maxTurns: 3,
  });
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'loop forever');
  assert.equal(res.turns, 3);
  assert.match(res.finalAnswer, /max turns/i);
});

test('agent: two sessions stay independent (window-1 vs window-2)', async () => {
  // Window 1: weather + todo
  const llm1 = new MockLLM([
    toolCall('weather', { city: 'Beijing' }),
    toolCall('todo', { action: 'add', text: 'bring umbrella' }),
    finalAnswer('done'),
  ]);
  // Window 2: separate agent instance emulating a second concurrent window
  const llm2 = new MockLLM([
    toolCall('todo', { action: 'add', text: 'write weekly report' }),
    toolCall('todo', { action: 'add', text: 'send to manager' }),
    finalAnswer('report plan captured'),
  ]);
  const reg = buildDefaultRegistry();
  const a1 = new Agent(llm1, reg, cfg);
  const a2 = new Agent(llm2, reg, cfg);
  const mgr = new SessionManager();
  const s1 = mgr.create('window-1');
  const s2 = mgr.create('window-2');

  await a1.chat(s1, 'plan the day');
  await a2.chat(s2, 'plan the weekly report');

  const t1 = (s1.state.todos as { items: Array<{ text: string }> }).items;
  const t2 = (s2.state.todos as { items: Array<{ text: string }> }).items;

  assert.deepEqual(t1.map((x) => x.text), ['bring umbrella']);
  assert.deepEqual(t2.map((x) => x.text), ['write weekly report', 'send to manager']);
  // No cross-contamination in history either.
  assert.ok(s1.history.every((m) => !m.content.includes('weekly report')));
  assert.ok(s2.history.every((m) => !m.content.includes('umbrella')));
});

test('agent: pure follow-up remembers prior turn state', async () => {
  const llm = new MockLLM([
    toolCall('todo', { action: 'add', text: 'read paper' }),
    finalAnswer('added #1'),
    // second user turn — pure dialog follow-up, no new tool call
    finalAnswer('You have 1 todo: "read paper".'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  await agent.chat(s, 'add read paper');
  const res = await agent.chat(s, 'what did I ask you to do?');
  assert.match(res.finalAnswer, /read paper/);
  // Second call's context should include the earlier turns.
  const secondCallMsgs = llm.calls[llm.calls.length - 1];
  const userMsgs = secondCallMsgs.filter((m) => m.role === 'user').map((m) => m.content);
  assert.ok(userMsgs.includes('add read paper'));
  assert.ok(userMsgs.includes('what did I ask you to do?'));
});

test('agent: follow-up with a new tool call reuses earlier context', async () => {
  const llm = new MockLLM([
    toolCall('weather', { city: 'Beijing' }),
    finalAnswer('Beijing: 24-33C, sunny w/ clouds'),
    // second turn — user asks a follow-up that also needs a tool
    toolCall('todo', { action: 'add', text: 'wear sunscreen in Beijing' }),
    finalAnswer('todo added given Beijing weather'),
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  await agent.chat(s, "what's the weather in Beijing?");
  const res = await agent.chat(s, 'ok, add a todo for that');
  assert.match(res.finalAnswer, /todo added/);
  const todos = (s.state.todos as { items: Array<{ text: string }> }).items;
  assert.equal(todos.length, 1);
});

test('agent: context compression fires when history grows past max', async () => {
  const compactCfg = {
    ...cfg,
    context: { maxMessages: 6, keepRecent: 2 },
  };
  // 5 short exchanges, each: user + tool_call + tool_result + final = 4 msgs added per chat.
  const llm = new MockLLM();
  for (let i = 0; i < 5; i++) {
    llm.enqueue(toolCall('calculator', { expression: `${i}+${i}` }));
    llm.enqueue(finalAnswer(`answer ${i}`));
  }
  const agent = new Agent(llm, buildDefaultRegistry(), compactCfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  for (let i = 0; i < 5; i++) await agent.chat(s, `q${i}`);

  const compressedEvents = s.trace.filter((t) => t.kind === 'compress');
  assert.ok(compressedEvents.length >= 1, 'expected at least one compression event');
  // After compression, history should not blow up.
  assert.ok(s.history.length <= compactCfg.context.maxMessages + 2);
  // 压缩后，第一条应该是一条 system 角色的摘要。
  const first = s.history[0];
  assert.equal(first.role, 'system');
  assert.match(first.content, /摘要/);
});

test('agent: LLM error surfaces gracefully', async () => {
  const llm = new MockLLM([
    () => { throw new Error('boom'); },
  ]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg);
  const mgr = new SessionManager();
  const s = mgr.create();
  const res = await agent.chat(s, 'go');
  assert.match(res.finalAnswer, /language model call failed/i);
});
