/**
 * 本地 token 估算 + 按类别的用量统计。
 *
 * 不做精确 tokenization —— 那要 tiktoken / 模型专用分词器，且不同模型差异不小。
 * 这里的目标只是"给用户一个直观的百分比"，所以走启发式：
 *   - ASCII 字符：≈ 4 字符/token
 *   - CJK 汉字：≈ 1.4 字符/token（更贴近 tiktoken 的 cl100k 分词行为）
 *   - 其它 Unicode：按 3 字符/token 打折
 *   - 每条消息额外加 4 个 token 的固定开销（role / 分隔符等结构开销）
 *
 * 数量级正确即可 —— 拿去做 UI 显示够用，不要拿去当计费依据。
 */

import type { Message } from './types.ts';

/** 消息在上下文里的类别 —— 用于饼状用量分析。 */
export type MsgCategory =
  | 'system'          // 系统 prompt（工具 schema + 角色约束等）
  | 'user'            // 用户输入
  | 'assistant'       // 模型输出（含思考、tool_call JSON、final_answer）
  | 'tool_result'     // 工具返回值
  | 'summary'         // 压缩摘要（走 system role，但语义是"折叠掉的旧历史"）
  | 'memory_facts';   // 跨会话记忆注入（走 system role，但内容是关于用户的 fact）

/** 拆分单条消息属于哪个类别。 */
export function categorize(m: Message): MsgCategory {
  if (m.role === 'user') return 'user';
  if (m.role === 'assistant') return 'assistant';
  if (m.role === 'tool') return 'tool_result';
  if (m.role === 'system') {
    // 压缩摘要：新格式「【已压缩 @segN …】」+ 旧 FIFO 摘要「早期对话摘要」。
    if (m.content.startsWith('【已压缩') || m.content.startsWith('早期对话摘要')) return 'summary';
    if (m.content.startsWith('关于本用户的已知信息')) return 'memory_facts';
  }
  return 'system';
}

const MESSAGE_OVERHEAD = 4;

/** 估算一段文本占多少 token（不含 message 结构开销）。 */
export function estimateTokensOfText(s: string): number {
  if (!s) return 0;
  let asciiChars = 0;
  let cjkChars = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) asciiChars++;
    else if (
      (cp >= 0x3400 && cp <= 0x9FFF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0x20000 && cp <= 0x2FFFF)
    ) cjkChars++;
    else other++;
  }
  // 累加，最少 1 token
  const t = Math.ceil(asciiChars / 4 + cjkChars / 1.4 + other / 3);
  return Math.max(1, t);
}

/**
 * 估算一条消息的 token 数（含结构开销）。
 * 关键：不能只数 content —— 工具调用的 args、DeepSeek 的 reasoning、Anthropic 的原始
 * content blocks 在线格式里都真实发送/占位，漏算会导致压缩触发严重偏晚 → context 400。
 */
export function estimateTokensOfMessage(m: Message): number {
  let t = estimateTokensOfText(m.content) + MESSAGE_OVERHEAD;
  // 工具调用参数：OpenAI 线格式里 function.arguments = JSON.stringify(args)，真实发送。
  if (m.toolCalls?.length) {
    for (const tc of m.toolCalls) {
      t += estimateTokensOfText(tc.name) + estimateTokensOfText(JSON.stringify(tc.args));
    }
  }
  // thinking：DeepSeek reasoning 是字符串；Anthropic 原始 blocks（含 thinking + tool_use input）
  // 会随 providerRaw 原样回传。两者都占真实 token。
  if (m.thinking?.raw != null) {
    const raw = m.thinking.raw;
    t += estimateTokensOfText(typeof raw === 'string' ? raw : JSON.stringify(raw));
  }
  return t;
}

/** 类别 → token 数。 */
export type CategoryBreakdown = Record<MsgCategory, number>;

function emptyBreakdown(): CategoryBreakdown {
  return { system: 0, user: 0, assistant: 0, tool_result: 0, summary: 0, memory_facts: 0 };
}

/**
 * 拿到一份完整 messages 数组的用量分解。
 * @param extras 额外的、不在 messages 里的段（这些段在实际请求里会被拼进 system role
 *   一起发给 LLM，但因为设计上不写回 history，需要单独计入才能得到真实用量）：
 *     - `extras.systemBase` → 归入 `system`
 *     - `extras.memory`     → 归入 `memory_facts`
 */
export function breakdown(
  messages: Message[],
  extras?: { systemBase?: string; memory?: string },
): CategoryBreakdown {
  const out = emptyBreakdown();
  for (const m of messages) {
    const cat = categorize(m);
    out[cat] += estimateTokensOfMessage(m);
  }
  if (extras?.systemBase) {
    out.system += estimateTokensOfMessage({ role: 'system', content: extras.systemBase });
  }
  if (extras?.memory) {
    out.memory_facts += estimateTokensOfMessage({ role: 'system', content: extras.memory });
  }
  return out;
}

/**
 * 会话真实用量分解 —— 把「不在 history 里、但每轮真发出去」的 system 段一并计入。
 *
 * system prompt 是每轮临时冻结/拼装的（工具 schema + 角色约束 + 记忆快照 + 账本），
 * 设计上不写回 history，所以直接对 history 做 breakdown 会让 system 类别恒为 ~0、
 * 总量严重偏低。这里从一轮 RunResult 拿到那几段，正确归类。
 *
 * 关键去重：freeze 后的 `systemBase` 里**已内嵌** memory 快照
 * （freeze = [base, memSnapshot, ledgerSeg]）。若把 memory 再单独计一次会双算，
 * 故先从 systemBase 里剥掉 memory 段，再把 memory 归到 memory_facts。
 *
 * @param seg.systemBase 冻结后的整段 system prompt（含内嵌 memory）
 * @param seg.memory     本轮记忆注入段（identity/preferences 快照）
 * @param seg.ledger     本轮账本渲染段（每轮作为末尾 system 消息注入，不在 history）
 */
export function breakdownWithSegments(
  history: Message[],
  seg: { systemBase?: string; memory?: string; ledger?: string },
): CategoryBreakdown {
  const memory = seg.memory ?? '';
  const systemBase = seg.systemBase ?? '';
  // 从 systemBase 剥离已内嵌的 memory 段，避免与下面 extras.memory 双算。
  const sysNoMem = memory && systemBase.includes(memory)
    ? systemBase.replace(memory, '')
    : systemBase;
  const systemForCount = [sysNoMem, seg.ledger ?? ''].filter((s) => s.length).join('\n\n');
  return breakdown(history, {
    systemBase: systemForCount || undefined,
    memory: memory || undefined,
  });
}

/** 总 token 数。 */
export function totalTokens(b: CategoryBreakdown): number {
  return b.system + b.user + b.assistant + b.tool_result + b.summary + b.memory_facts;
}

/**
 * 上下文窗口大小（从 env 读，默认 1M）。
 * 默认对齐 DeepSeek-V4 系列的 1,048,576(2^20) tokens；其它模型窗口不同的，
 * 用环境变量 LLM_CONTEXT_WINDOW 覆盖（例如老模型填 128000）。
 */
export function contextWindow(): number {
  const raw = process.env.LLM_CONTEXT_WINDOW;
  if (!raw) return 1_048_576;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1_048_576;
}

/** 数字友好显示：1234 → "1.2k"、1_234_567 → "1.2M"。 */
export function humanTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}
