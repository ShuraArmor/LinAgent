import type { LLMClient, Message } from './types.ts';

export interface ContextConfig {
  /** 历史消息条数超过此阈值就触发压缩。 */
  maxMessages: number;
  /** 触发压缩后，尾部保留多少条消息不动。 */
  keepRecent: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxMessages: 24,
  keepRecent: 8,
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}… [截断 ${s.length - n} 字符]`;
}

/** 纯代码的启发式总结器（不依赖 LLM，测试与降级路径都用它）。 */
export function heuristicSummarize(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') lines.push(`用户提问：${truncate(m.content, 200)}`);
    else if (m.role === 'assistant') lines.push(`助手回复：${truncate(m.content, 200)}`);
    else if (m.role === 'tool')
      lines.push(`工具(${m.toolName ?? '?'}) → ${truncate(m.content, 200)}`);
  }
  return `早期对话摘要：\n${lines.join('\n')}`;
}

/** 走 LLM 的总结器；失败时静默降级到启发式版本。 */
export async function llmSummarize(llm: LLMClient, messages: Message[]): Promise<string> {
  const transcript = messages
    .map((m) => {
      const tag = m.role === 'tool' ? `tool[${m.toolName ?? '?'}]` : m.role;
      return `${tag}: ${m.content}`;
    })
    .join('\n');
  const prompt: Message[] = [
    {
      role: 'system',
      content:
        '你负责压缩对话历史。用简短的要点式总结保留：用户目标、已做的决定、工具结果、以及未完成的事项。' +
        '直接输出纯文本（不要 JSON，不要代码围栏）。',
    },
    { role: 'user', content: transcript },
  ];
  try {
    const out = await llm.chat(prompt, { temperature: 0 });
    return `早期对话摘要：\n${out.trim()}`;
  } catch {
    return heuristicSummarize(messages);
  }
}

export interface CompressionResult {
  /** 压缩后的历史（若真的做了压缩，第一条会是一条 system 角色的摘要）。 */
  history: Message[];
  /** 本次是否真的执行了压缩。 */
  compressed: boolean;
  /** 有多少条消息被折进摘要。 */
  folded: number;
}

/**
 * 裁剪 + 压缩。若历史长度 ≤ maxMessages，原样返回；否则把除最近 `keepRecent` 条以外
 * 的所有消息折进一条 system 角色的摘要中，放在历史开头。
 */
export async function compressIfNeeded(
  history: Message[],
  config: ContextConfig,
  summarize: (msgs: Message[]) => Promise<string> | string,
): Promise<CompressionResult> {
  if (history.length <= config.maxMessages) {
    return { history, compressed: false, folded: 0 };
  }
  const foldCount = history.length - config.keepRecent;
  const toFold = history.slice(0, foldCount);
  const keep = history.slice(foldCount);
  const summary = await summarize(toFold);
  const summaryMsg: Message = { role: 'system', content: summary };
  return { history: [summaryMsg, ...keep], compressed: true, folded: foldCount };
}
