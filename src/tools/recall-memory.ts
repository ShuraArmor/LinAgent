/**
 * recall_memory —— 让 agent 按关键词主动召回跨会话记忆里的 facts / ongoing。
 *
 * 为什么要这个工具（而不是每轮自动注入 facts）：
 *   会话启动后 system prompt 冻结不变以保住 provider 的前缀缓存（见 agent.ts 冻结逻辑）。
 *   identity/preferences 是稳定的，会话首轮一次性写进冻结的 system 就够了；但 facts/ongoing
 *   是"按当前话题命中"的，每轮都变——若塞进 system 就会每轮破坏缓存。所以把它改成 agent
 *   按需主动查：结果作为 tool 消息进历史（history 尾部变化不碰 system 前缀），缓存不破。
 *
 * 设计取舍（对齐 recall_archive）：
 *   - 只读，不需要审批
 *   - 闭包捕获 store + userId（userId 在 runtime 装配时固定），不依赖 ctx
 *   - 命中为空时返回 { ok:true, facts:[] }，不 throw
 */

import type { Tool } from '../types.ts';
import { retrieveForQuery, formatForPrompt, bumpRecall } from '../memory.ts';
import type { MemoryStore, RecallReRankBias } from '../memory.ts';

const DEFAULT_TOPK = 5;

/**
 * @param resolveBias 可选：按当前会话 id 解析召回偏置（ConversationClass → RecallBias）。
 *   不传则退化为纯 Jaccard 召回（向后兼容）。让召回与压缩走同一根类别轴。
 */
export function buildRecallMemoryTool(
  store: MemoryStore,
  userId: string,
  resolveBias?: (sessionId: string | undefined) => RecallReRankBias | undefined,
  onRecall?: (hitKinds: string[]) => void,
): Tool {
  return {
    name: 'recall_memory',
    description:
      '按关键词召回关于当前用户的跨会话记忆（facts 一般事实 / ongoing 进行中的事）。' +
      '当任务涉及用户的偏好、历史、长期项目，而你手头上下文里没有相关信息时，先调这个查一下。' +
      '（用户的稳定身份/偏好已在系统提示里，不用查；这里查的是按话题命中的事实。）',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '召回用的关键词/短语，通常就是当前话题或用户提到的实体。',
        },
        topK: {
          type: 'number',
          description: `返回命中的最大条数，默认 ${DEFAULT_TOPK}。`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const query = args.query;
      if (typeof query !== 'string' || !query.trim()) {
        return { ok: false, error: 'query 必须是非空字符串' };
      }
      const topK = typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : DEFAULT_TOPK;
      const mem = store.load(userId);
      // 按当前会话类别取召回偏置（与压缩同一根轴）；解析失败/未配置则无偏置。
      const bias = resolveBias?.(ctx?.sessionId);
      // 只召回 facts / ongoing —— identity/preferences 已在冻结的 system 里，不重复。
      const hits = retrieveForQuery(mem, query, topK, bias).filter(
        (f) => f.layer === 'facts' || f.layer === 'ongoing',
      );
      // M2 反馈：命中的 fact 累加 recall_count（负反馈信号，下次 freeze 据此升级 tier）。
      // 实时落盘，跨会话累积；不动 tier 本身，故不碰当前会话的冻结快照。
      if (hits.length) {
        const bumped = bumpRecall(mem, hits.map((f) => f.id));
        if (bumped) store.save(mem);
        // Phase 2 反馈：把命中 fact 的原语 kind 报给控制器（负反馈环的误差信号）。
        // kind 是 M0 沉淀时带上的；缺失的跳过（不硬派 claim，避免污染信号）。
        if (onRecall) {
          const kinds = hits.map((f) => f.kind).filter((k): k is string => typeof k === 'string' && k.length > 0);
          if (kinds.length) onRecall(kinds);
        }
      }
      return {
        ok: true,
        query,
        class: bias?.class,
        count: hits.length,
        facts: hits.map((f) => ({ id: f.id, layer: f.layer, text: f.text })),
        rendered: hits.length ? formatForPrompt(hits) : '（没有命中的相关记忆）',
      };
    },
  };
}
