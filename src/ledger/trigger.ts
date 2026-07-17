/**
 * 压缩触发条件。
 *
 * 抛弃原来"消息条数 > 24 就触发"的粗暴规则，改成"输入 token 逼近可用窗口比例"。
 * 这跟 opencode / hermes 收敛的做法一致，也是 Batch 2 的第一条关键改进。
 *
 * 计算方式：
 *   usable  = contextWindow - outputReserve
 *   trigger = totalInputTokens >= usable * threshold_percent
 *
 * outputReserve 默认 20k（给模型的输出留 buffer，避免"输入撑满、输出被卡"）。
 * threshold_percent 默认 0.60（相比 opencode/hermes 的 0.50 略保守一点，因为我们的
 * token 估算精度只在 ±20% 左右，宁可早一点触发，别真撑到超限）。
 *
 * 关于抖动：压缩是**零 LLM** 的（合并摘要靠账本渲染，见 compressor.ts），即使连续几轮都
 * 触发也只是廉价的数组重排，没有"摘要器空转"的成本，因此不需要 back-off 机制。
 */

import type { Message } from '../types.ts';
import { estimateTokensOfMessage, estimateTokensOfText } from '../tokens.ts';

export interface CompressionTriggerConfig {
  /** 上下文窗口大小（token）。默认取 contextWindow() = 128k。 */
  contextWindow: number;
  /** 为输出预留的 token 数。默认 20000。 */
  outputReserve: number;
  /** 输入 token / 可用窗口 的触发阈值，0..1。默认 0.60。 */
  thresholdPercent: number;
  /** 保护尾巴用的 token 预算比例（相对 usable）。默认 0.20。 */
  tailBudgetPercent: number;
  /** 保护尾巴的最小消息条数下限；即使 token 预算超了也至少留这么多。默认 4。 */
  minTailMessages: number;
}

export const DEFAULT_TRIGGER: CompressionTriggerConfig = {
  contextWindow: 128_000,
  outputReserve: 20_000,
  thresholdPercent: 0.60,
  tailBudgetPercent: 0.20,
  minTailMessages: 4,
};

/** 从 env / 传入默认值构建一份完整 config。 */
export function buildTriggerConfig(overrides?: Partial<CompressionTriggerConfig>): CompressionTriggerConfig {
  const cw = Number(process.env.LLM_CONTEXT_WINDOW);
  const win = Number.isFinite(cw) && cw > 0 ? cw : DEFAULT_TRIGGER.contextWindow;
  return {
    ...DEFAULT_TRIGGER,
    contextWindow: win,
    ...overrides,
  };
}

/** 可用输入预算 = 窗口 - 输出预留。 */
export function usableTokens(cfg: CompressionTriggerConfig): number {
  return Math.max(0, cfg.contextWindow - cfg.outputReserve);
}

/** 触发阈值绝对值（token 数）。 */
export function triggerTokens(cfg: CompressionTriggerConfig): number {
  return Math.floor(usableTokens(cfg) * cfg.thresholdPercent);
}

/**
 * 判断当前 history 是否达到压缩触发条件。
 * @param extraSystemTokens 额外的 system 段 token（每轮临时拼进 prompt 的部分，
 *   例如账本渲染、记忆注入 —— 它们不在 history 里，但真发出去时占 token）。
 */
export function shouldCompress(
  history: Message[],
  extraSystemTokens: number,
  cfg: CompressionTriggerConfig,
): { yes: boolean; totalInput: number; threshold: number } {
  let total = extraSystemTokens;
  for (const m of history) total += estimateTokensOfMessage(m);
  const threshold = triggerTokens(cfg);
  return { yes: total >= threshold, totalInput: total, threshold };
}

/**
 * 从 history 尾部往回收，按 token 预算挑保护尾。
 * 保头单独处理（compressor.ts 会把第一条 user 消息单独 pin 住）。
 *
 * @returns 保护尾的**起始索引**（history[fromIndex..] 全部保留原文）。
 *   fromIndex 会至少落在能保住 minTailMessages 条的位置。
 */
export function pickTailStartIndex(
  history: Message[],
  cfg: CompressionTriggerConfig,
): number {
  if (history.length === 0) return 0;
  const budget = Math.floor(usableTokens(cfg) * cfg.tailBudgetPercent);
  let acc = 0;
  let idx = history.length;
  // 从最新一条往回吃
  while (idx > 0) {
    const t = estimateTokensOfMessage(history[idx - 1]);
    if (acc + t > budget && (history.length - idx) >= cfg.minTailMessages) break;
    acc += t;
    idx -= 1;
  }
  return idx;
}

/** 用于 debug/trace：估算一段文本能占多少 token。 */
export function estimateTextTokens(s: string): number {
  return s ? estimateTokensOfText(s) : 0;
}
