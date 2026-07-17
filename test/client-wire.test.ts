import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIClient, AnthropicClient } from '../src/llm/client.ts';
import type { Message } from '../src/types.ts';

// 用私有方法测线格式转换 —— 通过 as any 访问 toWireMessages / toWire。
// 这些是纯函数（不发网络），正好补上"离线测不到 wire 格式"的空白。

function oai() { return new OpenAIClient({ baseUrl: 'x', apiKey: 'x', model: 'm' }); }
function ant() { return new AnthropicClient({ baseUrl: 'x', apiKey: 'x', model: 'm' }); }

test('OpenAI wire: 正常 assistant(tool_calls) + tool 结果配对保留', () => {
  const msgs: Message[] = [
    { role: 'user', content: '算一下' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculator', args: { expression: '1+1' } }] },
    { role: 'tool', toolName: 'calculator', toolCallId: 'c1', content: '{"ok":true}' },
  ];
  const wire = (oai() as any).toWireMessages(msgs) as any[];
  assert.equal(wire.length, 3);
  assert.equal(wire[1].tool_calls[0].id, 'c1');
  assert.equal(wire[1].content, null);       // 有 tool_calls 时 content 允许 null
  assert.equal(wire[2].tool_call_id, 'c1');
});

test('OpenAI wire: 孤儿 tool 结果（无对应 tool_call）被丢弃', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'hi' },
    // 旧格式：assistant 没有 toolCalls，但后面跟了个 tool 消息
    { role: 'assistant', content: '好的' },
    { role: 'tool', toolName: 'x', toolCallId: 'orphan', content: '{}' },
  ];
  const wire = (oai() as any).toWireMessages(msgs) as any[];
  // 孤儿 tool 被丢，只剩 user + assistant
  assert.equal(wire.length, 2);
  assert.ok(!wire.some((m) => m.role === 'tool'));
});

test('OpenAI wire: 悬空 tool_call（无对应结果）被丢弃，避免 400', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'hi' },
    // assistant 发起了 c1，但没有任何 tool 结果跟上（比如审批崩了、或压缩切断）
    { role: 'assistant', content: '我调个工具', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
  ];
  const wire = (oai() as any).toWireMessages(msgs) as any[];
  const asst = wire.find((m) => m.role === 'assistant');
  // 悬空 tool_call 被剔除，content 退回字符串（无 tool_calls 的 assistant 不能 content:null）
  assert.ok(!asst.tool_calls, '悬空 tool_call 应被丢弃');
  assert.equal(asst.content, '我调个工具');
});

test('OpenAI wire: reasoning_content 绝不出现在输入 messages 里', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '答案', thinking: { provider: 'deepseek', raw: '一大段思考' } },
  ];
  const wire = (oai() as any).toWireMessages(msgs) as any[];
  const asst = wire.find((m) => m.role === 'assistant');
  assert.ok(!('reasoning_content' in asst), 'reasoning_content 不能进输入（DeepSeek 会 400）');
});

test('Anthropic wire: 跨 provider —— 从 toolCalls 重建 tool_use（providerRaw 缺失）', () => {
  // 模拟 DeepSeek 存的会话（assistant 有 toolCalls 但没有 providerRaw）切到 Anthropic 回放
  const msgs: Message[] = [
    { role: 'user', content: '算一下' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'calculator', args: { expression: '1+1' } }] },
    { role: 'tool', toolName: 'calculator', toolCallId: 'c1', content: '{"ok":true}' },
  ];
  const { wire } = (ant() as any).toWire(msgs) as { wire: any[] };
  // assistant 应重建出 tool_use block（不能只剩空 content）
  const asst = wire.find((m) => m.role === 'assistant');
  assert.ok(Array.isArray(asst.content), 'assistant content 应是 blocks 数组');
  const toolUse = asst.content.find((b: any) => b.type === 'tool_use');
  assert.ok(toolUse, '应重建出 tool_use block');
  assert.equal(toolUse.id, 'c1');
  assert.deepEqual(toolUse.input, { expression: '1+1' });
  // 对应的 tool_result 应保留（因为 tool_use 重建出来了，配对成立）
  const userWithResult = wire.find((m) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(userWithResult, 'tool_result 应作为 user 消息保留');
});

test('Anthropic wire: 纯工具调用（空文本）不发空 content', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
    { role: 'tool', toolName: 'x', toolCallId: 'c1', content: '{}' },
  ];
  const { wire } = (ant() as any).toWire(msgs) as { wire: any[] };
  const asst = wire.find((m) => m.role === 'assistant');
  // content 是 blocks 数组，且不含空 text block
  assert.ok(Array.isArray(asst.content));
  const emptyText = asst.content.find((b: any) => b.type === 'text' && !b.text.trim());
  assert.ok(!emptyText, '不应有空 text block');
  assert.ok(asst.content.some((b: any) => b.type === 'tool_use'), '应有 tool_use');
});

test('Anthropic wire: 悬空 tool_use（无结果）被丢弃', () => {
  const msgs: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '调工具', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
    // 没有 c1 的结果
  ];
  const { wire } = (ant() as any).toWire(msgs) as { wire: any[] };
  const asst = wire.find((m) => m.role === 'assistant');
  const toolUse = (asst.content as any[]).find?.((b: any) => b.type === 'tool_use');
  assert.ok(!toolUse, '悬空 tool_use 应被丢弃');
  // 只剩 text block
  assert.ok((asst.content as any[]).some((b: any) => b.type === 'text'));
});

// ── 错序历史自愈（并发写 history bug 的回归） ──────────────────────────
// 场景：assistant(tool_calls) 后面被插了 user + 另一个 assistant，tool 结果挤到后面。
// 这是两个 chat 并发写 session.history 造成的，之前会让 provider 400。

test('OpenAI wire: 错序历史被重排 —— tool 结果紧跟其 assistant', () => {
  const msgs: Message[] = [
    { role: 'user', content: '跑命令' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'A', name: 'bash_exec', args: {} }] }, // 发起 A
    { role: 'user', content: 'n' },                                     // ← 插进来的并发输入
    { role: 'assistant', content: '', toolCalls: [{ id: 'B', name: 'bash_exec', args: {} }] }, // 发起 B
    { role: 'tool', toolName: 'bash_exec', toolCallId: 'A', content: '{"a":1}' }, // A 的结果姗姗来迟
    { role: 'tool', toolName: 'bash_exec', toolCallId: 'B', content: '{"b":2}' },
  ];
  const wire = (oai() as any).toWireMessages(msgs) as any[];
  // 校验不变量：每个 assistant(tool_calls) 后必须紧跟且同序对应它的 tool 结果
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i];
    if (m.role === 'assistant' && m.tool_calls) {
      const ids = m.tool_calls.map((t: any) => t.id);
      const follow: string[] = [];
      let j = i + 1;
      while (j < wire.length && wire[j].role === 'tool') { follow.push(wire[j].tool_call_id); j++; }
      assert.deepEqual(follow, ids, `assistant@${i} 的 tool 结果应紧跟且同序`);
    }
    if (m.role === 'tool') {
      const prev = wire[i - 1];
      assert.ok(prev && (prev.role === 'assistant' || prev.role === 'tool'), `tool@${i} 前必须是 assistant/tool`);
    }
  }
  // tool 结果被拉回各自 assistant 后面，user "n" 留在原位（不再夹在 tool_calls 和结果之间）。
  const roles = wire.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'user', 'assistant', 'tool']);
});

test('Anthropic wire: 错序历史被重排 —— tool_result 紧跟其 assistant', () => {
  const msgs: Message[] = [
    { role: 'user', content: '跑命令' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'A', name: 'bash_exec', args: {} }] },
    { role: 'user', content: 'n' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'B', name: 'bash_exec', args: {} }] },
    { role: 'tool', toolName: 'bash_exec', toolCallId: 'A', content: '{"a":1}' },
    { role: 'tool', toolName: 'bash_exec', toolCallId: 'B', content: '{"b":2}' },
  ];
  const { wire } = (ant() as any).toWire(msgs) as { wire: any[] };
  // 每条含 tool_use 的 assistant 后必须紧跟一条带对应 tool_result 的 user 消息
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const useIds = (m.content as any[]).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!useIds.length) continue;
    const next = wire[i + 1];
    assert.ok(next && next.role === 'user' && Array.isArray(next.content), `assistant@${i} 后应紧跟 tool_result user 消息`);
    const resIds = (next.content as any[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    assert.deepEqual(resIds, useIds, 'tool_result 应与 tool_use 同序对应');
  }
});

test('OpenAI wire: 同一 tool 结果不会被两个 assistant 重复消费', () => {
  // 两个 assistant 都"声称"发起了 A（错乱历史可能出现），但只有一个结果 A。
  const msgs: Message[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'A', name: 'x', args: {} }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'A', name: 'x', args: {} }] },
    { role: 'tool', toolName: 'x', toolCallId: 'A', content: '{}' },
  ];
  const wire = (oai() as any).toWireMessages(msgs) as any[];
  const toolMsgs = wire.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 1, 'tool 结果只输出一次');
  // 第二个 assistant 的 A 被视为悬空（已消费）→ 退化成无 tool_calls 的 assistant
  const withCalls = wire.filter((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(withCalls.length, 1, '只有第一个 assistant 保留 tool_calls');
});
