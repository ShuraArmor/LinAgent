/**
 * recall_archive —— 让 agent 按 @segN 句柄回看被压缩掉的原始消息。
 *
 * 设计取舍：
 *   - 只读，不需要审批
 *   - 返回值是"渲染成文本的一段对话",不是原始 Message 结构 —— agent 只读一次就够
 *   - 长度超上限时给出提示（避免一口气把 100KB 归档拉回来又要压缩）
 *   - 找不到句柄时返回 error，不 throw（让 LLM 有机会自己纠正）
 *
 * 这个工具由 REPL / Agent 构造时按需注册，只有配了 archive store 才有它。
 */

import type { Tool } from '../types.ts';
import type { ArchiveStore } from '../ledger/archive.ts';
import { parseHandle } from '../ledger/archive.ts';

const MAX_CHARS = 8000;   // 一次拉回的字符上限，超过就截断

export function buildRecallArchiveTool(archive: ArchiveStore): Tool {
  return {
    name: 'recall_archive',
    description:
      '按 @segN 句柄回看被压缩后归档的原始对话消息。' +
      '通常不需要调用 —— 账本里的关键信息已经保留。' +
      '仅当账本某条 finding/decision 的细节确实必要、光看 text 不够时才用。',
    parameters: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: '归档段句柄，形如 "@seg3"',
        },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const raw = args.handle;
      if (typeof raw !== 'string') return { ok: false, error: 'handle 必须是字符串' };
      const segId = parseHandle(raw);
      if (!segId) return { ok: false, error: `句柄格式非法: "${raw}"（应形如 @seg3）` };

      const seg = archive.load(ctx.sessionId, segId);
      if (!seg) return { ok: false, error: `未找到归档段 ${raw}（本会话）` };

      // 渲染成人类可读的对话
      const lines: string[] = [];
      let charBudget = MAX_CHARS;
      let truncated = 0;
      for (const m of seg.messages) {
        if (charBudget <= 0) { truncated++; continue; }
        const tag = m.role === 'tool' ? `tool[${m.toolName ?? '?'}]` : m.role;
        const body = m.content || '';
        const line = `${tag}: ${body}`;
        if (line.length > charBudget) {
          lines.push(`${line.slice(0, charBudget)}… [此处截断]`);
          charBudget = 0;
        } else {
          lines.push(line);
          charBudget -= line.length + 1;
        }
      }
      return {
        ok: true,
        handle: raw,
        seg_id: segId,
        message_count: seg.messages.length,
        turn_at_archive: seg.turn_at_archive,
        rendered: lines.join('\n'),
        truncated_messages: truncated,
      };
    },
  };
}
