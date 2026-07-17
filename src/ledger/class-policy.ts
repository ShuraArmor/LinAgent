/**
 * ConversationClass —— 贯穿"压缩"与"记忆召回"两套机制的同一根轴。
 *
 * 核心思想（用户定的）：用户与 agent 的对话有一个**隐藏类别**，它不是用户显式选的，
 * 而是从对话本身涌现。类别决定对话结构，结构决定"什么重要"：
 *   - 排错(debug)      → 因果链/根因最重要，过程试错可删
 *   - 执行(execution)  → 做过的动作/产物最重要，推理次要
 *   - 头脑风暴(brainstorm) → 观点与决策最重要，推导可砍
 *   - 通用(default)    → 无强结构，保守压缩
 *
 * 所以压缩不该一刀切，召回也该偏向该类别相关的记忆。这个模块把"类别 → 压缩策略 /
 * 召回偏置"集中成查表，纯函数、零 LLM。类别本身在**压缩时刻**用当前账本算（见 resolveClass），
 * 不是首轮冻结那个 preset —— 那时账本已填满，判得更准。
 */

import type { Ledger } from './types.ts';
import type { Message } from '../types.ts';
import { pickPreset } from './preset.ts';
import type { Preset } from './types.ts';

/** 已知的对话类别。'default' 永远兜底。 */
export type ConversationClass = 'debug' | 'execution' | 'brainstorm' | 'default';

const KNOWN_CLASSES: ReadonlySet<string> = new Set(['debug', 'execution', 'brainstorm', 'default']);

/**
 * 一条中段消息的三种命运（保留度递增）：
 *   - delete ：纯噪音，原文丢弃、不进归档、不进摘要。信息完全放弃。
 *   - merge  ：要点已被账本吸收 → 原文丢弃、不进归档，但信息以"合并摘要"的形式保留。
 *   - archive：证据 → 原文落 @segN 归档段，recall_archive 可逐字召回。
 * 位置（头/尾/中）不再决定命运——命运只由"消息特征 × 对话类别"查表决定（除保尾近场 + intent 兜底）。
 */
export type Disposition = 'delete' | 'merge' | 'archive';

/**
 * 消息的语义特征（用便宜信号判定，不调 LLM）：
 *   user               —— 用户发言
 *   assistant_action   —— assistant 带 tool_calls（动作）
 *   assistant_reasoning—— assistant 纯文本（中间推理/叙述）
 *   tool_error         —— 工具结果，含报错特征
 *   tool_success       —— 工具结果，看起来成功
 */
export type MessageFeature =
  | 'user' | 'assistant_action' | 'assistant_reasoning' | 'tool_error' | 'tool_success';

/**
 * 压缩策略：某类别下，各种消息特征分别落到 delete/merge/archive 哪一档。
 */
export interface CompressionPolicy {
  /** 人类可读的类别名，用于渲染压缩摘要的标题。 */
  label: string;
  /**
   * 合并摘要渲染时，按此优先序从账本挑字段（点路径，相对 suggested / custom）。
   * 例：debug → ['custom.debug.causal_chain', 'suggested.findings', ...]。见 compressor。
   */
  summaryFields: string[];
  /** 消息特征 → 三档处置。这就是"类别决定什么重要"的落地。 */
  dispose: Record<MessageFeature, Disposition>;
}

/**
 * 召回偏置：某类别下，记忆召回该偏向哪些层 / 用哪些扩展关键词加权。
 */
export interface RecallBias {
  /** 该类别下更该优先召回的记忆层（命中则加权）。 */
  preferLayers: Array<'facts' | 'ongoing'>;
  /**
   * 该类别的特征词 —— 召回重排时，fact 文本命中这些词额外加权。
   * 不污染原始 query（不拼进去做 Jaccard），只用于对已召回结果重排。
   */
  boostKeywords: string[];
}

interface ClassProfile {
  compression: CompressionPolicy;
  recall: RecallBias;
}

// ── 每类的策略表 ────────────────────────────────────────────────────
const PROFILES: Record<ConversationClass, ClassProfile> = {
  // debug 排错：证据至上。工具输出（成功/报错都可能是线索）归档可召回；用户发言归档；
  // 中间推理含因果推断，合并进摘要（不逐字留、但要点不丢）。几乎不 delete。
  debug: {
    compression: {
      label: 'debug 排错',
      summaryFields: ['custom.debug.causal_chain', 'suggested.findings', 'suggested.decisions', 'suggested.blockers'],
      dispose: {
        user: 'archive',
        assistant_action: 'archive',
        assistant_reasoning: 'merge',
        tool_error: 'archive',
        tool_success: 'archive',
      },
    },
    recall: {
      preferLayers: ['facts'],
      boostKeywords: ['根因', '报错', '异常', '因果', 'bug', 'error', '修复', '定位'],
    },
  },
  // execution 执行：结果至上。成功命令的冗长 stdout 是噪音→delete；报错留证据→archive；
  // 动作与推理的要点已进账本 progress/artifacts→merge；用户指令归档。
  execution: {
    compression: {
      label: 'execution 执行',
      summaryFields: ['suggested.progress', 'suggested.artifacts', 'suggested.decisions', 'suggested.open_threads'],
      dispose: {
        user: 'archive',
        assistant_action: 'merge',
        assistant_reasoning: 'delete',
        tool_error: 'archive',
        tool_success: 'delete',
      },
    },
    recall: {
      preferLayers: ['facts', 'ongoing'],
      boostKeywords: ['部署', '配置', '安装', '构建', '产物', 'deploy', 'build', 'config'],
    },
  },
  // brainstorm 头脑风暴：观点/决策至上。推导过程可砍→delete；观点性发言与动作要点合并；
  // 工具很少用，成功输出删、报错归档。
  brainstorm: {
    compression: {
      label: 'brainstorm 头脑风暴',
      summaryFields: ['suggested.decisions', 'suggested.findings', 'custom.brainstorm.rejected'],
      dispose: {
        user: 'merge',
        assistant_action: 'merge',
        assistant_reasoning: 'delete',
        tool_error: 'archive',
        tool_success: 'delete',
      },
    },
    recall: {
      preferLayers: ['ongoing', 'facts'],
      boostKeywords: ['方案', '设计', '思路', '决定', '观点', 'idea', 'design'],
    },
  },
  // default 通用：无强结构 → 保守，一律归档（可召回），不 delete、不 merge。
  default: {
    compression: {
      label: '通用',
      summaryFields: ['suggested.findings', 'suggested.decisions', 'suggested.open_threads', 'suggested.progress'],
      dispose: {
        user: 'archive',
        assistant_action: 'archive',
        assistant_reasoning: 'archive',
        tool_error: 'archive',
        tool_success: 'archive',
      },
    },
    recall: {
      preferLayers: ['facts', 'ongoing'],
      boostKeywords: [],
    },
  },
};

/**
 * 把任意 preset 名规约成已知 ConversationClass。用户自定义 preset（名字不在已知集合里）
 * → 落到 default（保守压缩），符合"分类学涌现但未知类别不激进处置"的取舍。
 */
export function classFromPresetName(name: string | undefined): ConversationClass {
  if (name && KNOWN_CLASSES.has(name)) return name as ConversationClass;
  return 'default';
}

/**
 * 压缩时刻从账本涌现类别。用当前账本（intent + custom 命名空间已填满）跑 pickPreset，
 * 比首轮冻结那个准。userInput 传空 —— 压缩时没有"当前用户输入"，全靠账本状态。
 */
export function resolveClass(ledger: Ledger | undefined, presets?: Preset[]): ConversationClass {
  if (!ledger) return 'default';
  // 账本 intent 拼上已有 custom 命名空间，作为 pickPreset 的匹配文本。
  const nsText = Object.keys(ledger.custom).join(' ');
  const sel = pickPreset(ledger, nsText, presets);
  return classFromPresetName(sel.preset.name);
}

/** 取某类别的压缩策略。 */
export function compressionPolicyFor(cls: ConversationClass): CompressionPolicy {
  return PROFILES[cls].compression;
}

/** 取某类别的召回偏置。 */
export function recallBiasFor(cls: ConversationClass): RecallBias {
  return PROFILES[cls].recall;
}

/** 报错特征词 —— 工具结果命中则算 tool_error（是证据，倾向归档）。 */
const ERROR_RE = /error|错误|失败|exception|traceback|fail|✗|❌|not found|denied|拒绝/i;

/** 把一条消息归到某个 MessageFeature（便宜信号，不调 LLM）。 */
export function featureOf(m: Message): MessageFeature {
  if (m.role === 'tool') return ERROR_RE.test(m.content) ? 'tool_error' : 'tool_success';
  if (m.role === 'assistant') {
    return (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) ? 'assistant_action' : 'assistant_reasoning';
  }
  // user 及其它（system 等散件不会进中段处置，这里给 user 兜底）
  return 'user';
}

/** 一条消息在某类别下的最终处置。 */
export function disposeOf(m: Message, policy: CompressionPolicy): Disposition {
  return policy.dispose[featureOf(m)];
}
