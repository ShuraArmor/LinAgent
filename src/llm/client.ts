import type {
  LLMClient, LLMChatOpts, Message, ChatRequest, AssistantTurn, ToolCallRequest,
} from '../types.ts';
import { PROVIDERS, listProviders } from './providers.ts';

/**
 * 默认输出上限。历史上是 4096 —— 但工具调用的 arguments（尤其 fs_write 写整个代码文件、
 * 或一轮里批量发多个工具）很容易超过它被截断，截断后 arguments 是残缺 JSON、parse 失败，
 * 表现成"模型少传参数"。拉到 8192 大幅降低截断概率；真超了也有 finish_reason 检测兜底报错。
 * 可用环境变量 LLM_MAX_TOKENS 覆盖。
 */
const DEFAULT_MAX_TOKENS = (() => {
  const v = Number(process.env.LLM_MAX_TOKENS);
  return Number.isFinite(v) && v > 0 ? v : 8192;
})();

export class LLMHttpError extends Error {
  constructor(msg: string, public status: number, public body: string) { super(msg); }
}

/** 从 Anthropic 原始 content blocks 里抽出所有 tool_use 的 id（用于判断 raw 是否含悬空 tool_use）。 */
function extractToolUseIds(blocks: unknown[]): string[] {
  const ids: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') {
      const id = (b as { id?: unknown }).id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

interface HttpClientOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** provider 是否支持 response_format:json_schema（否则 complete() 降级到 json_object）。 */
  supportsJsonSchema?: boolean;
}

/**
 * 空闲超时：每次 `kick()` 重置计时器；`idleMs` 内没有任何 `kick()` 才 `abort()`。
 * 流式请求用它替代"总时长超时"——只要还在持续收到数据就不超时，长回复不会被误杀，
 * 卡死连接仍能被及时掐断。首字节等待期由 fetch 前启动的定时器覆盖（未 kick 即视为无响应）。
 */
/** 空闲超时触发时抛的错误 —— 比裸 AbortError 的 "This operation was aborted" 有信息量。 */
export class LLMTimeoutError extends Error {
  constructor(public idleMs: number) {
    const secs = idleMs >= 1000 ? `${Math.round(idleMs / 1000)} 秒` : `${idleMs} 毫秒`;
    super(`LLM 响应空闲超时：${secs}内没有收到任何数据（可能是网络卡顿或 provider 无响应）。可调大 LLM_TIMEOUT_MS。`);
    this.name = 'LLMTimeoutError';
  }
}

function idleTimeout(
  idleMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; kick: () => void; clear: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 外部信号（用户打断）：立即把打断原因转发到本 controller，让 fetch 断流。
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const kick = () => {
    if (timer) clearTimeout(timer);
    // abort(reason)：把超时原因带进 signal.reason，catch 处可辨认并给出清晰信息。
    timer = setTimeout(() => controller.abort(new LLMTimeoutError(idleMs)), idleMs);
  };
  kick();  // 启动：覆盖发请求到首字节的等待
  return {
    signal: controller.signal,
    kick,
    clear: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * 从 Web ReadableStream 上逐行迭代 SSE 的 `data:` 行。
 * onActivity：每次从网络读到数据就回调一次（流式用它 kick 空闲超时）。
 */
async function* sseLines(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();  // 收到网络数据 → 重置空闲超时
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trimStart();
}

/**
 * OpenAI 兼容协议客户端（OpenAI、DeepSeek、Moonshot、OpenRouter、DashScope、智谱、Groq、Ollama）。
 *
 * 工具调用走原生 `tools` / `tool_calls` 协议：
 *   - 请求带 tools（{type:"function", function:{name,description,parameters}}）
 *   - 响应读 choices[0].message.tool_calls；function.arguments 是 JSON 字符串，client 层 parse
 *   - 工具结果回传用 role:"tool" + tool_call_id
 *   - DeepSeek reasoning 模型的 reasoning_content 原样保存 + 多轮回传
 */
export class OpenAIClient implements LLMClient {
  readonly name = 'openai';
  constructor(private readonly opts: HttpClientOpts) {}

  /**
   * 把内部 Message[] 转成 OpenAI 线格式 messages。
   *
   * 关键不变量：每条 assistant(tool_calls) 在 wire 里后面**紧跟且仅跟**它自己的、存在的
   * tool 结果。OpenAI/DeepSeek 要求 "assistant with tool_calls 必须被对应 tool 消息紧接"，
   * 中间不能插 user/另一个 assistant。
   *
   * 为什么要重排而不只是过滤：并发写 history 的 bug（REPL 可重入）会把 tool 结果挤到
   * 后面很远、中间插入 user / 另一个 assistant。仅做"成员配对过滤"救不了顺序 —— 必须
   * 按 assistant 分组，把散落各处的 tool 结果拉回它自己的 assistant 后面。这样既自愈已
   * 存下的坏会话，也对未来的错序免疫。
   */
  private toWireMessages(messages: Message[]): unknown[] {
    // toolCallId -> tool 消息（只认第一个，重复的丢）。
    const resultById = new Map<string, Message>();
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId && !resultById.has(m.toolCallId)) {
        resultById.set(m.toolCallId, m);
      }
    }
    const consumed = new Set<string>();   // 已被某个 assistant 消费掉的 tool 结果 id
    const wire: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        // 游离 tool 消息在这里一律跳过 —— 它们只在其 assistant 组内被输出（见下）。
        continue;
      }
      if (m.role === 'assistant') {
        // 只保留"有对应结果、且尚未被别的 assistant 消费"的 tool_call。
        const validCalls = (m.toolCalls ?? []).filter(
          (tc) => tc.id && resultById.has(tc.id) && !consumed.has(tc.id),
        );
        const msg: Record<string, unknown> = { role: 'assistant' };
        if (validCalls.length) {
          msg.content = m.content || null;   // 有 tool_calls 时 content 允许 null
          msg.tool_calls = validCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
          wire.push(msg);
          // 紧跟着按 tool_calls 顺序输出对应结果，保证协议要求的"紧邻"。
          for (const tc of validCalls) {
            const tm = resultById.get(tc.id)!;
            consumed.add(tc.id);
            wire.push({ role: 'tool', tool_call_id: tc.id, content: tm.content });
          }
        } else {
          // 无有效工具调用 —— content 不能是 null（无 tool_calls 的 assistant 要求 content）。
          msg.content = m.content || '';
          wire.push(msg);
        }
        // 注意：DeepSeek 的 reasoning_content 是**纯输出字段**，绝不能出现在输入 messages 里
        // （出现会 400）。thinking 只用于 UI 展示，不进线格式回传。
        continue;
      }
      wire.push({ role: m.role, content: m.content });
    }
    return wire;
  }

  async chat(req: ChatRequest): Promise<AssistantTurn> {
    const stream = Boolean(req.onDelta);
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: this.opts.model,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream,
      messages: this.toWireMessages(req.messages),
    };
    if (req.tools?.length) {
      payload.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      payload.tool_choice = req.toolChoice ?? 'auto';
    }

    // 流式用空闲超时（每收到一个 chunk 重置）——长回复只要在持续输出就不会被误杀；
    // 非流式用总时长超时（没有中间进度，总时长才是合理边界）。
    // external=req.signal：用户打断（Esc）时立即断流。
    const idleMs = this.opts.timeoutMs ?? 60_000;
    const to = idleTimeout(idleMs, req.signal);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
        signal: to.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(`LLM HTTP ${res.status}`, res.status, text);
      }
      const turn = stream ? await this.parseStream(res, req, to.kick) : await this.parseJson(res);
      return await healTruncatedToolCalls(turn, req.messages, (m, o) => this.complete(m, o));
    } finally {
      to.clear();
    }
  }

  private async parseJson(res: Response): Promise<AssistantTurn> {
    const json = (await res.json()) as {
      choices?: Array<{ finish_reason?: string | null; message?: {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      } }>;
    };
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const toolCalls = parseOpenAIToolCalls(msg?.tool_calls, choice?.finish_reason ?? undefined);
    const turn: AssistantTurn = {
      text: typeof msg?.content === 'string' ? msg.content : '',
      toolCalls,
    };
    if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content) {
      turn.thinking = { provider: 'deepseek', raw: msg.reasoning_content };
    }
    return turn;
  }

  private async parseStream(res: Response, req: ChatRequest, kick?: () => void): Promise<AssistantTurn> {
    if (!res.body) throw new Error('LLM 流式响应缺少 body');
    let text = '';
    let reasoning = '';
    let finishReason: string | undefined;
    // 按 index 累积工具调用分片
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    for await (const data of sseLines(res.body, kick)) {
      if (data === '[DONE]') break;
      let evt: {
        choices?: Array<{ finish_reason?: string | null; delta?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        } }>;
      };
      try { evt = JSON.parse(data); } catch { continue; }
      const choice = evt.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length) {
        text += delta.content;
        req.onDelta!(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
        reasoning += delta.reasoning_content;
        req.onReasoningDelta?.(delta.reasoning_content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let acc = toolAcc.get(idx);
        if (!acc) { acc = { id: '', name: '', args: '' }; toolAcc.set(idx, acc); }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
    const toolCalls: ToolCallRequest[] = [];
    for (const acc of [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
      if (!acc.name) continue;
      const { args, parseError, truncatedRaw } = parseToolArgs(acc.name, acc.args, finishReason);
      toolCalls.push({
        id: acc.id, name: acc.name, args,
        ...(parseError ? { parseError } : {}),
        ...(truncatedRaw !== undefined ? { truncatedRaw } : {}),
      });
    }
    const turn: AssistantTurn = { text, toolCalls };
    if (reasoning) turn.thinking = { provider: 'deepseek', raw: reasoning };
    return turn;
  }

  async complete(messages: Message[], opts?: LLMChatOpts): Promise<string> {
    const stream = Boolean(opts?.onDelta);
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload: Record<string, unknown> = {
      model: this.opts.model,
      temperature: opts?.temperature ?? 0.2,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream,
      messages: this.toWireMessages(messages),
    };
    // 结构化输出。只有官方 OpenAI 稳定支持 json_schema；其它兼容 provider（DeepSeek 等）
    // 对 json_schema 会 400，降级到 json_object（schema 靠 prompt 描述 + 调用方代码校验兜底）。
    let messagesForCall = messages;
    if (opts?.jsonSchema) {
      if (this.opts.supportsJsonSchema) {
        payload.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: false },
        };
      } else {
        payload.response_format = { type: 'json_object' };
        // DeepSeek 的 json_object 模式硬性要求：messages 里必须出现 "json" 字样。
        // 给 system 段补一句，保证满足（planner/orchestrator 的 prompt 已描述了 schema）。
        messagesForCall = ensureJsonHint(messages);
      }
      payload.messages = this.toWireMessages(messagesForCall);
    }
    const idleMs = this.opts.timeoutMs ?? 60_000;
    const to = idleTimeout(idleMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
        signal: to.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(`LLM HTTP ${res.status}`, res.status, text);
      }
      if (!stream) {
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('LLM 响应缺少 content 字段');
        return content;
      }
      if (!res.body) throw new Error('LLM 流式响应缺少 body');
      let full = '';
      for await (const data of sseLines(res.body, to.kick)) {
        if (data === '[DONE]') break;
        try {
          const evt = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = evt.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) { full += delta; opts!.onDelta!(delta); }
        } catch { /* 跳过 keepalive */ }
      }
      return full;
    } finally {
      to.clear();
    }
  }
}

/** Anthropic Messages API 客户端。 */
export class AnthropicClient implements LLMClient {
  readonly name = 'anthropic';
  constructor(private readonly opts: HttpClientOpts) {}

  /**
   * 把内部 Message[] 转成 Anthropic 线格式。
   * - system 消息抽出来单独作为 top-level system
   * - assistant 消息：若有 providerRaw（原始 content blocks，含 thinking/tool_use），原样用
   * - tool 消息：合并连续的 tool 结果到同一条 user 消息（Anthropic 要求并行结果同一条 user）
   */
  private toWire(messages: Message[]): { system: string; wire: unknown[] } {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');

    // toolCallId -> tool 消息（只认第一个）。
    const resultById = new Map<string, Message>();
    for (const m of rest) {
      if (m.role === 'tool' && m.toolCallId && !resultById.has(m.toolCallId)) {
        resultById.set(m.toolCallId, m);
      }
    }
    const consumed = new Set<string>();

    // 输出一条 assistant + 紧跟其 tool_result（作为一条 user 消息，Anthropic 要求并行结果同条）。
    // 关键不变量与 OpenAI 侧相同：把散落的 tool 结果拉回其 assistant 后面，自愈并发写造成的错序。
    const wire: unknown[] = [];
    for (const m of rest) {
      if (m.role === 'tool') {
        // 游离 tool 消息一律跳过 —— 只在其 assistant 组内输出。
        continue;
      }
      if (m.role === 'assistant') {
        // 该 assistant 的有效 tool_use id：有结果且未被消费。
        const calls = m.toolCalls ?? [];
        const validIds = calls.map((tc) => tc.id).filter((id): id is string =>
          Boolean(id) && resultById.has(id!) && !consumed.has(id!));
        const validSet = new Set(validIds);

        // 判断能否直接用 provider 原始 blocks：仅当 providerRaw 里每个 tool_use 都有效（无悬空）。
        // 否则从 toolCalls 重建，过滤掉悬空/已消费的 tool_use，避免 400。
        let contentBlocks: unknown[];
        const rawToolUseIds = Array.isArray(m.providerRaw) ? extractToolUseIds(m.providerRaw) : null;
        const rawIsClean = rawToolUseIds !== null
          && rawToolUseIds.every((id) => validSet.has(id))
          && rawToolUseIds.length === validIds.length;
        if (rawIsClean) {
          contentBlocks = m.providerRaw as unknown[];
        } else {
          const blocks: unknown[] = [];
          if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
          for (const tc of calls) {
            if (tc.id && validSet.has(tc.id)) {
              blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
            }
          }
          if (blocks.length === 0) blocks.push({ type: 'text', text: '(no content)' });
          contentBlocks = blocks;
        }
        wire.push({ role: 'assistant', content: contentBlocks });

        // 紧跟着按 tool_calls 顺序输出对应结果（同一条 user 消息）。
        if (validIds.length) {
          const toolResults = validIds.map((id) => {
            consumed.add(id);
            return { type: 'tool_result', tool_use_id: id, content: resultById.get(id)!.content };
          });
          wire.push({ role: 'user', content: toolResults });
        }
        continue;
      }
      wire.push({ role: 'user', content: m.content });
    }
    return { system, wire };
  }

  async chat(req: ChatRequest): Promise<AssistantTurn> {
    const stream = Boolean(req.onDelta);
    const { system, wire } = this.toWire(req.messages);
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const payload: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? 0.2,
      stream,
      system: system || undefined,
      messages: wire,
    };
    if (req.tools?.length) {
      payload.tools = req.tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      }));
      if (req.toolChoice === 'required') payload.tool_choice = { type: 'any' };
      else if (req.toolChoice === 'none') payload.tool_choice = { type: 'none' };
      else payload.tool_choice = { type: 'auto' };
    }
    // external=req.signal：用户打断（Esc）时立即断流。
    const idleMs = this.opts.timeoutMs ?? 60_000;
    const to = idleTimeout(idleMs, req.signal);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01',
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
        signal: to.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(`LLM HTTP ${res.status}`, res.status, text);
      }
      const turn = stream ? await this.parseStream(res, req, to.kick) : await this.parseJson(res);
      return await healTruncatedToolCalls(turn, req.messages, (m, o) => this.complete(m, o));
    } finally {
      to.clear();
    }
  }

  private async parseJson(res: Response): Promise<AssistantTurn> {
    const json = (await res.json()) as { content?: Array<Record<string, unknown>> };
    const blocks = json.content ?? [];
    return this.blocksToTurn(blocks);
  }

  /** 把 Anthropic content blocks 组装成 AssistantTurn；providerRaw 存原始 blocks。 */
  private blocksToTurn(blocks: Array<Record<string, unknown>>): AssistantTurn {
    let text = '';
    const toolCalls: ToolCallRequest[] = [];
    let hasThinking = false;
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      else if (b.type === 'tool_use') {
        toolCalls.push({
          id: String(b.id ?? ''),
          name: String(b.name ?? ''),
          args: (b.input && typeof b.input === 'object') ? (b.input as Record<string, unknown>) : {},
          ...(typeof b.__parseError === 'string' ? { parseError: b.__parseError } : {}),
          ...(typeof b.__truncatedRaw === 'string' ? { truncatedRaw: b.__truncatedRaw } : {}),
        });
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        hasThinking = true;
      }
    }
    const turn: AssistantTurn = { text, toolCalls, raw: blocks };
    // thinking：整组 blocks 原样存，回传时用（Anthropic 要求 thinking block 原样、含 signature）
    if (hasThinking) turn.thinking = { provider: 'anthropic', raw: blocks };
    return turn;
  }

  private async parseStream(res: Response, req: ChatRequest, kick?: () => void): Promise<AssistantTurn> {
    if (!res.body) throw new Error('LLM 流式响应缺少 body');
    // 按 index 累积 content blocks
    const blocks = new Map<number, Record<string, unknown>>();
    const toolArgsAcc = new Map<number, string>();
    let stopReason: string | undefined;
    for await (const data of sseLines(res.body, kick)) {
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(data); } catch { continue; }
      const type = evt.type;
      if (type === 'message_delta') {
        // Anthropic 把 stop_reason 放在 message_delta.delta.stop_reason；'max_tokens'=被截断。
        const sr = (evt.delta as { stop_reason?: string } | undefined)?.stop_reason;
        if (sr) stopReason = sr;
      }
      if (type === 'content_block_start') {
        const idx = evt.index as number;
        const block = evt.content_block as Record<string, unknown>;
        blocks.set(idx, { ...block });
        if (block.type === 'tool_use') toolArgsAcc.set(idx, '');
      } else if (type === 'content_block_delta') {
        const idx = evt.index as number;
        const delta = evt.delta as Record<string, unknown>;
        const block = blocks.get(idx);
        if (!block) continue;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = String(block.text ?? '') + delta.text;
          req.onDelta!(delta.text);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          toolArgsAcc.set(idx, (toolArgsAcc.get(idx) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = String(block.thinking ?? '') + delta.thinking;
          req.onReasoningDelta?.(delta.thinking);
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = String(block.signature ?? '') + delta.signature;
        }
      }
    }
    // 把累积的 tool_use input JSON parse 回对象。把 Anthropic 的 'max_tokens' 归一成 'length'，
    // 复用 parseToolArgs 的截断提示。
    const fr = stopReason === 'max_tokens' ? 'length' : stopReason;
    const orderedBlocks: Array<Record<string, unknown>> = [];
    for (const [idx, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.type === 'tool_use') {
        const { args, parseError, truncatedRaw } = parseToolArgs(String(block.name ?? ''), toolArgsAcc.get(idx) ?? '', fr);
        block.input = args;
        if (parseError) block.__parseError = parseError;
        if (truncatedRaw !== undefined) block.__truncatedRaw = truncatedRaw;
      }
      orderedBlocks.push(block);
    }
    return this.blocksToTurn(orderedBlocks);
  }

  async complete(messages: Message[], opts?: LLMChatOpts): Promise<string> {
    // 结构化输出：Anthropic 没有 response_format，用强制单工具 emit 等价实现
    if (opts?.jsonSchema) {
      const turn = await this.chat({
        messages,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        tools: [{
          name: opts.jsonSchema.name,
          description: `产出符合 schema 的 ${opts.jsonSchema.name} 对象`,
          parameters: opts.jsonSchema.schema,
        }],
        toolChoice: 'required',
      });
      const call = turn.toolCalls[0];
      if (!call) throw new Error('Anthropic 结构化输出：未产出工具调用');
      return JSON.stringify(call.args);
    }
    // 纯文本
    const stream = Boolean(opts?.onDelta);
    const { system, wire } = this.toWire(messages);
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const payload = {
      model: this.opts.model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature ?? 0.2,
      stream,
      system: system || undefined,
      messages: wire,
    };
    const idleMs = this.opts.timeoutMs ?? 60_000;
    const to = idleTimeout(idleMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01',
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
        signal: to.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(`LLM HTTP ${res.status}`, res.status, text);
      }
      if (!stream) {
        const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        const chunk = json.content?.find((c) => c.type === 'text');
        if (!chunk?.text) throw new Error('LLM 响应缺少 text 内容');
        return chunk.text;
      }
      if (!res.body) throw new Error('LLM 流式响应缺少 body');
      let full = '';
      for await (const data of sseLines(res.body, to.kick)) {
        try {
          const evt = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const tx = evt.delta.text ?? '';
            if (tx) { full += tx; opts!.onDelta!(tx); }
          }
        } catch { /* 忽略 */ }
      }
      return full;
    } finally {
      to.clear();
    }
  }
}

// ── 辅助 ─────────────────────────────────────────────────────────────────

function parseOpenAIToolCalls(
  raw: Array<{ id?: string; function?: { name?: string; arguments?: string } }> | undefined,
  finishReason?: string,
): ToolCallRequest[] {
  if (!raw?.length) return [];
  const out: ToolCallRequest[] = [];
  for (const tc of raw) {
    const name = tc.function?.name;
    if (!name) continue;
    const { args, parseError, truncatedRaw } = parseToolArgs(name, tc.function?.arguments ?? '', finishReason);
    out.push({
      id: tc.id ?? '', name, args,
      ...(parseError ? { parseError } : {}),
      ...(truncatedRaw !== undefined ? { truncatedRaw } : {}),
    });
  }
  return out;
}

/** parse 工具参数 JSON 字符串；失败返回空对象（不崩，交给 schema 校验兜底）。 */
/** json_object 模式要求 messages 含 "json" 字样 —— 给 system 段补一句（若还没有）。 */
function ensureJsonHint(messages: Message[]): Message[] {
  const hasJson = messages.some((m) => /json/i.test(m.content));
  if (hasJson) return messages;
  const out = [...messages];
  const sysIdx = out.findIndex((m) => m.role === 'system');
  const hint = '\n\n请只输出一个合法的 JSON 对象。';
  if (sysIdx >= 0) {
    out[sysIdx] = { ...out[sysIdx], content: out[sysIdx].content + hint };
  } else {
    out.unshift({ role: 'system', content: '请只输出一个合法的 JSON 对象。' });
  }
  return out;
}

/** 工具参数被截断时，自动续写的最大轮数（每轮再要一次补全）。 */
const MAX_ARG_CONTINUATIONS = 6;

/** 去掉模型可能多包的 ```json ... ``` 围栏 / 前后缀说明，尽量只留裸 JSON 续写。 */
function stripJsonFence(s: string): string {
  let t = s;
  // 去掉整段 ```lang ... ``` 包裹
  const fence = t.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  if (fence) t = fence[1];
  // 去掉行首残留的 ``` 起止行
  t = t.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
  return t;
}

/** 试着把字符串解析成 JSON 对象；成功且是对象才返回，否则 null。 */
function tryParseArgsObj(s: string): Record<string, unknown> | null {
  if (!s || !s.trim()) return null;
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * 工具参数被 max_tokens 截断时的**自动续写拼接**（用户与 agent 循环都无感）。
 *
 * 场景：fs_write 等工具的 content 很大，一次生成放不下 → provider 在 arguments JSON 中途截断。
 * 与其把错误抛给用户/让上层重发，不如客户端自己接着要：把已生成的残缺片段回喂给模型，让它
 * **只输出剩余字符**，拼回去再解析。这样长文件写入对使用者是完全透明的一次成功调用。
 *
 * 稳健性：每轮续写自身也可能再被截断 → 循环累积，直到 JSON 闭合或到达 MAX_ARG_CONTINUATIONS。
 * 全部失败则返回 null，上层退回原来的 parseError 行为（即最坏情况 == 改动前）。
 *
 * @param complete 纯文本补全回调（各 client 自己的 complete，非流式，不污染 UI）
 * @param origMessages 本轮原始消息（给模型足够上下文知道自己在写什么）
 * @param toolName 工具名
 * @param partial 已生成的残缺 arguments JSON 片段
 */
async function reconstructToolArgs(
  complete: (messages: Message[], opts?: LLMChatOpts) => Promise<string>,
  origMessages: Message[],
  toolName: string,
  partial: string,
): Promise<Record<string, unknown> | null> {
  let acc = partial;
  for (let round = 0; round < MAX_ARG_CONTINUATIONS; round++) {
    const done = tryParseArgsObj(acc);
    if (done) return done;
    const contMessages: Message[] = [
      ...origMessages,
      {
        role: 'user',
        content:
          `你上一次对工具「${toolName}」的调用参数（一个 JSON 对象）因长度限制被截断了。\n` +
          `下面是已经生成的残缺 JSON 片段。请**紧接着它继续输出剩余的字符**，直到整个 JSON 对象闭合。\n` +
          `严格要求：\n` +
          `1) 只输出续写部分，绝不重复已有内容；\n` +
          `2) 不要任何解释文字，不要 markdown 围栏；\n` +
          `3) 保持在原来的 JSON 字符串/结构里续写（注意转义与引号闭合）。\n\n` +
          `已生成片段（请从它的末尾继续）：\n${acc}`,
      },
    ];
    let piece: string;
    try {
      piece = stripJsonFence(await complete(contMessages));
    } catch {
      return null;  // 续写请求本身失败 → 交回上层
    }
    // 策略1：拼接续写；策略2：模型可能直接重发了整段完整 JSON。
    const joined = acc + piece;
    const p1 = tryParseArgsObj(joined);
    if (p1) return p1;
    const p2 = tryParseArgsObj(piece);
    if (p2) return p2;
    acc = joined;  // 仍未闭合（这轮可能又被截断）→ 累积后继续下一轮
  }
  return null;
}

/**
 * 对一轮回复里被 max_tokens 截断的工具调用逐个做自动续写拼接（OpenAI / Anthropic 共用）。
 * 续写成功 → 补齐 args、清掉 parseError；失败 → 原样保留（退回 parseError 行为，最坏 == 改动前）。
 * 无论成败都清掉内部字段 truncatedRaw，不让它进对话历史。
 */
async function healTruncatedToolCalls(
  turn: AssistantTurn,
  origMessages: Message[],
  complete: (messages: Message[], opts?: LLMChatOpts) => Promise<string>,
): Promise<AssistantTurn> {
  for (const tc of turn.toolCalls) {
    if (tc.truncatedRaw === undefined) continue;
    const fixed = await reconstructToolArgs(complete, origMessages, tc.name, tc.truncatedRaw);
    if (fixed) { tc.args = fixed; delete tc.parseError; }
    delete tc.truncatedRaw;
  }
  return turn;
}

/**
 * 解析工具调用的 arguments 字符串（OpenAI 协议里它是 JSON 字符串）。
 *
 * 关键：**不再静默把解析失败吞成 {}**。历史上那样做，会让"输出被 max_tokens 截断成残缺
 * JSON"伪装成"模型少传参数"（executor 拿空 args 跑校验 → 报 缺 path/content）。现在解析失败
 * 时返回 parseError，executor 会把真实原因回喂给模型让它重发。
 *
 * @param name 工具名（仅用于错误信息）
 * @param s 累积/原始的 arguments 字符串
 * @param finishReason provider 的 finish_reason；==='length' 说明输出被截断，据此给更准的提示
 */
function parseToolArgs(
  name: string,
  s: string,
  finishReason?: string,
): { args: Record<string, unknown>; parseError?: string; truncatedRaw?: string } {
  // 空 arguments 是合法的（无参工具，如 list_tasks）——但若同时 finish_reason=length，
  // 说明是被截断到一个字都没发出来，也算截断。
  if (!s || !s.trim()) {
    if (finishReason === 'length') {
      return { args: {}, truncatedRaw: '', parseError: `工具 ${name} 的参数为空且输出被截断（finish_reason=length）——很可能 max_tokens 太小。请重发这次调用，参数更精简（如分多次写文件）。` };
    }
    return { args: {} };
  }
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { args: obj };
    return { args: {}, parseError: `工具 ${name} 的参数不是 JSON 对象：${s.slice(0, 120)}` };
  } catch {
    const truncated = finishReason === 'length';
    const hint = truncated
      ? '输出被 max_tokens 截断，参数 JSON 不完整'
      : '参数 JSON 解析失败';
    return {
      args: {},
      // truncatedRaw：残缺片段原文，供上层自动续写拼接（reconstructToolArgs）。
      // 只有确属截断（finish_reason=length）才给，普通坏 JSON 不触发续写（续写救不了）。
      ...(truncated ? { truncatedRaw: s } : {}),
      parseError: `工具 ${name} 的${hint}（不是你少传参数，是这次调用没发完）。请重新发起这次调用；` +
        `若因内容过长被截断，改为分多次、每次更短的内容。残缺原文（前120字）：${s.slice(0, 120)}`,
    };
  }
}

/**
 * 从 env 构造 LLM 客户端。见 providers.ts 的 preset 表。
 */
/** CLI 旗标覆盖项。优先级：overrides > env > preset 默认。空/undefined 视为未提供。 */
export interface LLMOverrides {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function buildLLMFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: LLMOverrides = {},
): LLMClient {
  const providerName = (overrides.provider ?? env.LLM_PROVIDER ?? 'openai').toLowerCase();
  const preset = PROVIDERS[providerName];
  if (!preset) {
    throw new Error(`Unknown provider "${providerName}"。可用 preset:\n${listProviders()}`);
  }
  const baseUrl = overrides.baseUrl ?? env.LLM_BASE_URL ?? preset.baseUrl;
  const model = overrides.model ?? env.LLM_MODEL ?? preset.defaultModel;
  const apiKey = overrides.apiKey ?? env.LLM_API_KEY ?? (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined);
  const timeoutMs = overrides.timeoutMs ?? (env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined);
  if (!apiKey) {
    const hint = preset.apiKeyEnv ? ` 或 ${preset.apiKeyEnv}` : '';
    throw new Error(`API key 未设置：用 --api-key、LLM_API_KEY${hint}（provider: ${providerName}）`);
  }
  const common = { baseUrl, apiKey, model, timeoutMs, supportsJsonSchema: preset.supportsJsonSchema };
  return preset.protocol === 'anthropic'
    ? new AnthropicClient(common)
    : new OpenAIClient(common);
}
