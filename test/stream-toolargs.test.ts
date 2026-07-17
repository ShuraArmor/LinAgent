import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIClient, AnthropicClient } from '../src/llm/client.ts';

/**
 * 流式工具调用的 arguments 分片拼接 + 截断检测。
 * 这块历史上没测试覆盖，正是"fs_write/bash_exec 老报少传参数"的真凶所在：
 * 输出被 max_tokens 截断 → arguments 残缺 → 旧 safeParseArgs 静默变 {} → 误报缺参数。
 */

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const l of frames) c.enqueue(enc.encode(l)); c.close(); } });
}
const oaiFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function stubFetch(frames: string[]) {
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(sseBody(frames), { status: 200 });
}

test('流式工具参数：分片正常拼接 → 完整 args', async () => {
  stubFetch([
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fs_write', arguments: '' } }] } }] }),
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a' } }] } }] }),
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt","content":"hi"}' } }] } }] }),
    'data: [DONE]\n\n',
  ]);
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} });
  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(turn.toolCalls[0].args, { path: 'a.txt', content: 'hi' });
  assert.equal(turn.toolCalls[0].parseError, undefined);
});

test('流式工具参数：并行两工具（index 0/1 交错）各自完整', async () => {
  stubFetch([
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'weather', arguments: '' } }] } }] }),
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', function: { name: 'fs_read', arguments: '' } }] } }] }),
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"BJ"}' } }] } }] }),
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"path":"x"}' } }] } }] }),
    'data: [DONE]\n\n',
  ]);
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} });
  assert.equal(turn.toolCalls.length, 2);
  assert.deepEqual(turn.toolCalls[0].args, { city: 'BJ' });
  assert.deepEqual(turn.toolCalls[1].args, { path: 'x' });
});

test('流式工具参数：被 max_tokens 截断 → parseError（不再静默变缺参数）', async () => {
  stubFetch([
    oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fs_write', arguments: '{"path":"a.js","content":"const x' } }] } }] }),
    oaiFrame({ choices: [{ finish_reason: 'length', delta: {} }] }),
    'data: [DONE]\n\n',
  ]);
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} });
  assert.equal(turn.toolCalls.length, 1);
  assert.ok(turn.toolCalls[0].parseError, '截断应产生 parseError');
  assert.match(turn.toolCalls[0].parseError!, /截断|没发完/, 'parseError 应说明是截断而非缺参数');
});

test('非流式工具参数：finish_reason=length 时空 arguments 也报 parseError', async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { tool_calls: [{ id: 'c', function: { name: 'bash_exec', arguments: '' } }] } }],
    }), { status: 200 });
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] });  // 非流式（无 onDelta）
  assert.equal(turn.toolCalls.length, 1);
  assert.ok(turn.toolCalls[0].parseError, '截断+空参数应报 parseError');
});

test('Anthropic 流式：stop_reason=max_tokens 截断 tool_use → parseError', async () => {
  const af = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  stubFetch([
    af({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'fs_write', input: {} } }),
    af({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js","content":"con' } }),
    af({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
  ]);
  const c = new AnthropicClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} });
  assert.equal(turn.toolCalls.length, 1);
  assert.ok(turn.toolCalls[0].parseError, 'Anthropic 截断也应报 parseError');
});

/**
 * 流式空闲超时（idle timeout）——修复"总时长超时误杀长回复"。
 * 关键：只要还在持续收到 chunk 就不超时；只有卡死才 abort。
 */

// 慢但持续：每 chunkDelay 发一个，共 count 个，最后 [DONE]。总时长远超 idle。
function steadyStream(count: number, chunkDelay: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (i < count) {
        await new Promise((r) => setTimeout(r, chunkDelay));
        c.enqueue(enc.encode(oaiFrame({ choices: [{ delta: { content: 'x' } }] })));
        i++;
      } else {
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      }
    },
  });
}

// 卡死：发一个后永不再发，但监听 signal（模拟真实 fetch 的 signal→body 连线）。
function stallStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    start(c) { signal.addEventListener('abort', () => c.error(signal.reason ?? new Error('aborted'))); },
    pull(c) { if (!sent) { sent = true; c.enqueue(enc.encode(oaiFrame({ choices: [{ delta: { content: 'x' } }] }))); } },
  });
}

test('流式空闲超时：慢但持续的长回复不被误杀（总时长 > idle）', async () => {
  // 10 个 chunk × 40ms = 总 ~400ms，远超 idle 150ms。旧"总时长超时"会挂；空闲超时应成功。
  (globalThis as unknown as { fetch: unknown }).fetch = async () =>
    new Response(steadyStream(10, 40), { status: 200 });
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm', timeoutMs: 150 });
  const out = await c.complete([{ role: 'user', content: 'x' }], { onDelta: () => {} });
  assert.equal(out, 'x'.repeat(10), '持续输出应完整收完，不被超时中断');
});

test('流式空闲超时：卡死的连接会被中断并报清晰错误', async () => {
  (globalThis as unknown as { fetch: unknown }).fetch = async (_u: string, init: { signal: AbortSignal }) =>
    new Response(stallStream(init.signal), { status: 200 });
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm', timeoutMs: 150 });
  await assert.rejects(
    () => c.complete([{ role: 'user', content: 'x' }], { onDelta: () => {} }),
    (err: Error) => /超时|aborted/i.test(err.message),
    '卡死应被空闲超时中断',
  );
});

/**
 * 大参数被 max_tokens 截断 → 客户端自动续写拼接（用户与 agent 循环都无感）。
 * 这是 fs_write 写大文件的核心修复：不再把截断错误抛给用户，而是自己接着要、拼回去。
 */
test('工具参数截断：自动续写拼接，透明补全（fs_write 大文件）', async () => {
  const full = JSON.stringify({ path: 'big.js', content: 'A'.repeat(500) });
  const cut = 200;
  let call = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    call++;
    if (call === 1) {
      // 第一轮流式：arguments 只发到 cut，然后 finish_reason=length（被截断）
      return new Response(sseBody([
        oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fs_write', arguments: full.slice(0, cut) } }] } }] }),
        oaiFrame({ choices: [{ finish_reason: 'length', delta: {} }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    // 续写轮（complete 非流式）：返回剩余字符
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: full.slice(cut) } }] }), { status: 200 });
  };
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: '写大文件' }], tools: [], onDelta: () => {} });
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].parseError, undefined, '续写成功后不应残留 parseError（用户无感）');
  assert.equal(turn.toolCalls[0].args.path, 'big.js');
  assert.equal(turn.toolCalls[0].args.content, 'A'.repeat(500), 'content 应被完整拼回');
  assert.equal(turn.toolCalls[0].truncatedRaw, undefined, '内部字段 truncatedRaw 应被清除');
});

test('工具参数截断：续写救不回来时退回 parseError（不崩、最坏 == 改动前）', async () => {
  let call = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = async () => {
    call++;
    if (call === 1) {
      return new Response(sseBody([
        oaiFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'fs_write', arguments: '{"path":"x","content":"unterminated' } }] } }] }),
        oaiFrame({ choices: [{ finish_reason: 'length', delta: {} }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '仍然无法闭合的垃圾' } }] }), { status: 200 });
  };
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm' });
  const turn = await c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {} });
  assert.ok(turn.toolCalls[0].parseError, '续写失败应退回 parseError 让上层重发');
  assert.equal(turn.toolCalls[0].truncatedRaw, undefined, 'truncatedRaw 无论成败都应清除');
});

test('打断：req.signal aborted 时 fetch 立即断流（用户 Esc）', async () => {
  // 假 body：监听 signal，abort 时让 read() 出错（模拟真实 fetch 的 signal→body 连线）。
  function abortableStall(signal: AbortSignal): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let sent = false;
    return new ReadableStream({
      start(c) { signal.addEventListener('abort', () => c.error(signal.reason ?? new Error('aborted'))); },
      pull(c) { if (!sent) { sent = true; c.enqueue(enc.encode(oaiFrame({ choices: [{ delta: { content: '开始' } }] }))); } },
    });
  }
  (globalThis as unknown as { fetch: unknown }).fetch = async (_u: string, init: { signal: AbortSignal }) =>
    new Response(abortableStall(init.signal), { status: 200 });

  const ctrl = new AbortController();
  const c = new OpenAIClient({ baseUrl: 'x', apiKey: 'k', model: 'm', timeoutMs: 60_000 });
  // 100ms 后模拟用户打断
  setTimeout(() => ctrl.abort(new Error('用户打断')), 100);
  await assert.rejects(
    () => c.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], onDelta: () => {}, signal: ctrl.signal }),
    (err: Error) => /打断|aborted/i.test(err.message) || err.name === 'AbortError',
    '用户打断应让 fetch 断流并抛错',
  );
});
