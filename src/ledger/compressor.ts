/**
 * 基于账本的上下文压缩。
 *
 * 与旧的 context.ts 有本质区别：
 *   旧：把老消息折成一条自由文本"早期对话摘要"，原文丢失
 *   新：老消息归档到独立文件（可 recall），账本本身是结构化的"摘要"
 *
 * 触发时的动作序列：
 *   1. 判断是否触发（trigger.shouldCompress）
 *   2. 保头：history[0]（用户最初一条 user 消息）永远逐字保留
 *   3. 保尾：从后往前按 token 预算挑，装不下的边界回合切分
 *   4. 中段归档：把 head 和 tail 之间的消息落到 archive/<sid>-<segN>.json
 *   5. 视图重建：history = [head, {system: "@segN 已归档，见账本"}, ...tail]
 *
 * 关键取舍：**不调 LLM 做摘要**。理由——账本本身是活的、结构化的、由 agent 自己
 * 维护的档案。压缩这一步的信息保留全靠账本，摘要器成本就省了。
 * （账本对齐 refactor pass 是 Batch 3+ 才做的可选优化，Batch 2 先跑通"账本已经
 *  够用作压缩产物"这个假设。）
 */

import type { Message, TraceEntry } from '../types.ts';
import type { ArchiveStore } from './archive.ts';
import type { Ledger, LedgerItem, Preset } from './types.ts';
import { shouldCompress, pickTailStartIndex, estimateTextTokens, type CompressionTriggerConfig } from './trigger.ts';
import { estimateTokensOfMessage } from '../tokens.ts';
import { resolveClass, compressionPolicyFor, disposeOf, type ConversationClass, type CompressionPolicy } from './class-policy.ts';

export interface CompressionInput {
  session_id: string;
  history: Message[];
  ledger?: Ledger;
  /** 每轮临时拼进 system prompt 的额外文本（工具 schema + 账本渲染 + 记忆注入）。 */
  extraSystemText: string;
  turn: number;
  cfg: CompressionTriggerConfig;
  archive: ArchiveStore;
  /** 可选 preset 库，用于压缩时刻从账本涌现 ConversationClass（不传用内置）。 */
  presets?: Preset[];
  /**
   * 强制压缩：跳过 token 阈值判断（用户手动 /compress 时用）。
   * 注意仍要求"保头和保尾之间有可归档的中段"——history 太短时依然 no-op。
   */
  force?: boolean;
}

export interface CompressionOutput {
  compressed: boolean;
  history: Message[];
  /** 若做了压缩，归档段的句柄（"@seg3"）。 */
  handle?: string;
  /** 归档了多少条消息（落 @seg，可 recall_archive 召回）。 */
  archived: number;
  /** 合并了多少条消息（要点进摘要、原文丢弃）。 */
  merged: number;
  /** 直接删除（不可召回、不进摘要）了多少条消息。 */
  deleted: number;
  /** 本次压缩涌现出的对话类别。 */
  conversationClass: ConversationClass;
  /** 触发前的总输入 token 估算。 */
  beforeTokens: number;
  /** 触发后的总输入 token 估算。 */
  afterTokens: number;
}

/**
 * 取账本里"还没打 archived_ref"的条目 —— 它们正是证据落在本次归档段里的条目
 * （见 tagLedgerItemsWithHandle 的对称逻辑）。按点路径归组返回。
 * 路径形如 'suggested.findings' / 'custom.debug.causal_chain'。
 */
function collectUntaggedByPath(ledger: Ledger): Map<string, LedgerItem[]> {
  const out = new Map<string, LedgerItem[]>();
  const take = (path: string, items?: LedgerItem[]) => {
    if (!items) return;
    const fresh = items.filter((it) => !it.archived_ref);
    if (fresh.length) out.set(path, fresh);
  };
  const s = ledger.suggested;
  take('suggested.progress', s.progress);
  take('suggested.findings', s.findings);
  take('suggested.decisions', s.decisions);
  take('suggested.open_threads', s.open_threads);
  take('suggested.blockers', s.blockers);
  take('suggested.artifacts', s.artifacts);
  for (const [key, arr] of Object.entries(ledger.custom)) take(`custom.${key}`, arr);
  return out;
}

/** 点路径的末段字段名，做渲染小标题（'suggested.findings' → 'findings'）。 */
function fieldLabel(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1];
}

/**
 * 构造"合并成的那一条"消息 —— 零 LLM。内容 = 本次要归档的那批账本条目，
 * 按类别 summaryFields 的优先序渲染。账本这段为空 → 降级为纯归档说明（不编造）。
 */
function makeMergeSummary(
  handle: string,
  cls: ConversationClass,
  policy: CompressionPolicy,
  ledger: Ledger | undefined,
  archivedCount: number,
  deletedCount: number,
  mergedCount: number,
  turnAtArchive: number,
): Message {
  // 有归档段才在标题带 handle；全删无归档时不带假 handle。
  const seg = handle ? `${handle} · ` : '';
  const lines: string[] = [`【已压缩 ${seg}${policy.label}会话 · 第 ${turnAtArchive} 轮之前】`];

  let rendered = 0;
  if (ledger) {
    const byPath = collectUntaggedByPath(ledger);
    // 先按类别优先序渲染 summaryFields，再补渲染其它未列出的未归档条目（避免丢信息）。
    const seen = new Set<string>();
    const emit = (path: string) => {
      const items = byPath.get(path);
      if (!items || !items.length) return;
      seen.add(path);
      lines.push(`· ${fieldLabel(path)}:`);
      for (const it of items) {
        const st = it.status ? ` [${it.status}]` : '';
        lines.push(`    - ${it.text}${st}`);
        rendered += 1;
      }
    };
    for (const path of policy.summaryFields) emit(path);
    for (const path of byPath.keys()) if (!seen.has(path)) emit(path);
  }

  if (rendered === 0) {
    // 账本没记要点 —— 老实说明，别假装有摘要。
    lines.push('（账本未记录本段要点；如需内容请回看归档原文。）');
  }

  const recov: string[] = [];
  if (archivedCount > 0) {
    recov.push(`${archivedCount} 条原始消息已归档，调用 recall_archive 工具（handle="${handle}"）可回看`);
  }
  if (mergedCount > 0) {
    recov.push(`${mergedCount} 条过程消息的要点已并入上面的摘要（原文不保留）`);
  }
  if (deletedCount > 0) {
    recov.push(`${deletedCount} 条噪音消息已按 ${policy.label} 策略删除（不可恢复）`);
  }
  if (recov.length) lines.push(`（${recov.join('；')}。）`);

  return { role: 'system', content: lines.join('\n') };
}

/** 检查一条消息是不是我们自己写的压缩摘要（避免误处置它）。带不带 handle 都要认出来。 */
function isCompressionSummary(m: Message): boolean {
  return m.role === 'system' && m.content.startsWith('【已压缩');
}

/**
 * 尝试压缩（类别驱动）。若不达阈值则 no-op；否则：
 *   1. 从当前账本涌现 ConversationClass（debug/execution/brainstorm/default）
 *   2. 钉住保头（首条 user）+ 保尾（最近若干条）—— 协议锚，与类别无关
 *   3. 中段每条按类别策略分路：delete（噪音且账本已吸收）/ archive（证据落 @seg）
 *   4. 合并成一条：本次归档的账本条目按类别 summaryFields 渲染（零 LLM）
 *   5. 视图重建：中段整体离场（无悬空 tool_call），换成 [摘要] 一条
 */
export function tryCompress(input: CompressionInput): CompressionOutput {
  const extraTokens = estimateTextTokens(input.extraSystemText);
  const trigger = shouldCompress(input.history, extraTokens, input.cfg);
  const cls = resolveClass(input.ledger, input.presets);
  const policy = compressionPolicyFor(cls);

  const noop = (): CompressionOutput => ({
    compressed: false, history: input.history, archived: 0, merged: 0, deleted: 0,
    conversationClass: cls, beforeTokens: trigger.totalInput, afterTokens: trigger.totalInput,
  });

  // force 时无视阈值直接压（手动 /compress）；否则按 token 占比判断。
  if (!input.force && !trigger.yes) return noop();

  // 「保头」不再是位置豁免——任务锚点优先由账本 core.intent 承载。仅当 intent 为空时，
  // 才把第一条 user 消息 pin 住兜底（否则连"在干嘛"都丢了）。intent 非空时，第一条 user
  // 和其它消息一样交给类别策略处置。
  const intentAnchors = Boolean(input.ledger?.core.intent && input.ledger.core.intent.trim());
  let headIdx = -1;
  if (!intentAnchors) {
    for (let i = 0; i < input.history.length; i++) {
      if (input.history[i].role === 'user') { headIdx = i; break; }
    }
  }

  // 保尾起始索引——只保护"正在进行的近场"。force 时把预算压到最小。
  const tailCfg = input.force
    ? { ...input.cfg, tailBudgetPercent: 0, minTailMessages: input.cfg.minTailMessages }
    : input.cfg;
  const tailStart = pickTailStartIndex(input.history, tailCfg);

  // 中段 = [headIdx+1 .. tailStart)（intent 兜底保头时）或 [0 .. tailStart)（intent 承载锚点时）。
  const middleStart = headIdx >= 0 ? headIdx + 1 : 0;
  if (tailStart <= middleStart) return noop();  // 没有可处置的中段

  const prefix = headIdx >= 0 ? input.history.slice(0, headIdx) : [];
  const head = headIdx >= 0 ? [input.history[headIdx]] : [];
  const middleRaw = input.history.slice(middleStart, tailStart);
  const tail = input.history.slice(tailStart);

  // 排除中段里已有的压缩摘要 —— 不重复处置，但保留在视图里（累积归档链）。
  const middle = middleRaw.filter((m) => !isCompressionSummary(m));
  const displacedSummaries = middleRaw.filter(isCompressionSummary);
  if (middle.length === 0) return noop();

  // 类别驱动地把中段分成三组：delete（丢弃）/ merge（要点进摘要、原文丢）/ archive（落 @seg 可召回）。
  const toArchive: Message[] = [];
  let deletedCount = 0;
  let mergedCount = 0;
  for (const m of middle) {
    const d = disposeOf(m, policy);
    if (d === 'delete') deletedCount += 1;
    else if (d === 'merge') mergedCount += 1;
    else toArchive.push(m);
  }

  // 归档组落盘（delete/merge 都不进归档）。没有可归档内容就不建段。
  let handle = '';
  if (toArchive.length > 0) {
    const res = input.archive.archive(input.session_id, toArchive, input.turn);
    handle = res.handle;
  }

  // 合并摘要：本次归档 + 合并的账本要点，按类别 summaryFields 渲染（零 LLM）。
  // 顺序：先渲染（读未打标记条目）、再 tag（打 archived_ref）——反了会渲染出空。
  const summary = makeMergeSummary(
    handle, cls, policy, input.ledger,
    toArchive.length, deletedCount, mergedCount, input.turn,
  );
  if (input.ledger && handle) tagLedgerItemsWithHandle(input.ledger, handle);

  // 视图重建：[保头前散件] + [兜底保头（若有）] + [旧摘要] + [本次摘要] + [保尾]。
  // 中段整体离场，无悬空 tool_call。
  const newHistory: Message[] = [...prefix, ...head, ...displacedSummaries, summary, ...tail];

  let after = extraTokens;
  for (const m of newHistory) after += estimateTokensOfMessage(m);

  return {
    compressed: true,
    history: newHistory,
    handle: handle || undefined,
    archived: toArchive.length,
    merged: mergedCount,
    deleted: deletedCount,
    conversationClass: cls,
    beforeTokens: trigger.totalInput,
    afterTokens: after,
  };
}


/**
 * 给账本里"还没打 archived_ref"的条目补上当前归档段的句柄。
 * 这样 agent 看账本时能知道哪条条目对应的原始消息在哪个归档段。
 *
 * 简单启发式：假设本次压缩之前的所有账本条目，都可能引用刚归档掉的这批消息 —— 只要
 * 该条目还没打 archived_ref，就打上。已有 archived_ref 的（引用更早归档段的）不动。
 */
function tagLedgerItemsWithHandle(ledger: Ledger, handle: string): void {
  const tag = (items?: import('./types.ts').LedgerItem[]) => {
    if (!items) return;
    for (const it of items) {
      if (!it.archived_ref) it.archived_ref = handle;
    }
  };
  const s = ledger.suggested;
  tag(s.progress); tag(s.findings); tag(s.decisions);
  tag(s.open_threads); tag(s.blockers); tag(s.artifacts);
  for (const arr of Object.values(ledger.custom)) tag(arr);
}

/** Trace 事件的载荷格式，Agent 里 push('compress', ...) 用它。 */
export interface CompressTraceData {
  handle?: string;
  archived: number;
  merged: number;
  deleted: number;
  conversationClass: ConversationClass;
  beforeTokens: number;
  afterTokens: number;
  savedPct: number;
  compressed: boolean;
}

export function compressTraceData(out: CompressionOutput): CompressTraceData {
  const saved = out.beforeTokens > 0
    ? Math.round((1 - out.afterTokens / out.beforeTokens) * 100)
    : 0;
  return {
    compressed: out.compressed,
    handle: out.handle,
    archived: out.archived,
    merged: out.merged,
    deleted: out.deleted,
    conversationClass: out.conversationClass,
    beforeTokens: out.beforeTokens,
    afterTokens: out.afterTokens,
    savedPct: saved,
  };
}
