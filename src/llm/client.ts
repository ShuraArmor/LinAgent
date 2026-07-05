import type { LLMClient, LLMChatOpts, Message } from '../types.ts';
import { PROVIDERS, listProviders } from './providers.ts';

export class LLMHttpError extends Error {
  constructor(msg: string, public status: number, public body: string) { super(msg); }
}

interface HttpClientOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** 从 Web ReadableStream 上逐行迭代 SSE 的 `data:` 行。 */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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

/** OpenAI 兼容协议客户端（OpenAI、DeepSeek、Moonshot、OpenRouter、DashScope、智谱、Groq、Ollama 等）。 */
export class OpenAIClient implements LLMClient {
  readonly name = 'openai';
  constructor(private readonly opts: HttpClientOpts) {}

  async chat(messages: Message[], opts?: LLMChatOpts): Promise<string> {
    const stream = Boolean(opts?.onDelta);
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload = {
      model: this.opts.model,
      temperature: opts?.temperature ?? 0.2,
      stream,
      messages: messages.map((m) => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content:
          m.role === 'tool'
            ? `[tool_result:${m.toolName ?? 'unknown'}]\n${m.content}`
            : m.content,
      })),
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new LLMHttpError(`LLM HTTP ${res.status}`, res.status, text);
      }

      if (!stream) {
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('LLM 响应缺少 content 字段');
        return content;
      }

      if (!res.body) throw new Error('LLM 流式响应缺少 body');
      let full = '';
      for await (const data of sseLines(res.body)) {
        if (data === '[DONE]') break;
        try {
          const evt = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = evt.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            full += delta;
            opts!.onDelta!(delta);
          }
        } catch {
          // 跳过非 JSON 的 keepalive 行
        }
      }
      return full;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Anthropic Messages API 客户端。 */
export class AnthropicClient implements LLMClient {
  readonly name = 'anthropic';
  constructor(private readonly opts: HttpClientOpts) {}

  async chat(messages: Message[], opts?: LLMChatOpts): Promise<string> {
    const stream = Boolean(opts?.onDelta);
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const payload = {
      model: this.opts.model,
      max_tokens: 1024,
      temperature: opts?.temperature ?? 0.2,
      stream,
      system: sys || undefined,
      messages: rest.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content:
          m.role === 'tool'
            ? `[tool_result:${m.toolName ?? 'unknown'}]\n${m.content}`
            : m.content,
      })),
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
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
        signal: controller.signal,
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
      for await (const data of sseLines(res.body)) {
        try {
          const evt = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const t = evt.delta.text ?? '';
            if (t) { full += t; opts!.onDelta!(t); }
          }
        } catch {
          // 忽略解析失败的 chunk
        }
      }
      return full;
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * 从 env 构造 LLM 客户端。只有两个字段是必需的：
 *   LLM_PROVIDER   — providers.ts 里的 preset 名（默认 openai）
 *   LLM_API_KEY    — key；也可以放到该 provider 的惯用 env 变量里
 *                    （例如 OPENAI_API_KEY / DEEPSEEK_API_KEY / …）
 *
 * 可选覆盖：
 *   LLM_MODEL      — 覆盖 preset 的默认模型
 *   LLM_BASE_URL   — 覆盖 preset 的 baseUrl（比如走公司代理）
 *   LLM_TIMEOUT_MS — 单次请求超时，默认 60000
 */
export function buildLLMFromEnv(env: NodeJS.ProcessEnv = process.env): LLMClient {
  const providerName = (env.LLM_PROVIDER ?? 'openai').toLowerCase();
  const preset = PROVIDERS[providerName];
  if (!preset) {
    throw new Error(
      `Unknown LLM_PROVIDER "${providerName}"。可用 preset:\n${listProviders()}`,
    );
  }

  const baseUrl = env.LLM_BASE_URL ?? preset.baseUrl;
  const model = env.LLM_MODEL ?? preset.defaultModel;
  const apiKey =
    env.LLM_API_KEY ?? (preset.apiKeyEnv ? env[preset.apiKeyEnv] : undefined);
  const timeoutMs = env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined;

  if (!apiKey) {
    const hint = preset.apiKeyEnv ? ` 或 ${preset.apiKeyEnv}` : '';
    throw new Error(`LLM_API_KEY${hint} is not set（provider: ${providerName}）`);
  }

  const common = { baseUrl, apiKey, model, timeoutMs };
  return preset.protocol === 'anthropic'
    ? new AnthropicClient(common)
    : new OpenAIClient(common);
}
