import type { Tool } from '../types.ts';

export const memoryTool: Tool = {
  name: 'memory',
  description:
    '读取或编辑当前用户的跨会话记忆。动作：list、add(layer, text)、forget(id)。' +
    '分层：identity | preferences | facts | ongoing。当用户要求"记住/忘掉"某事时使用。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'forget'],
        description: '要执行的操作。',
      },
      layer: {
        type: 'string',
        enum: ['identity', 'preferences', 'facts', 'ongoing'],
        description: '记忆所在层（add 时必填）。',
      },
      text: { type: 'string', description: '事实文本（add 时必填）。' },
      id: { type: 'string', description: '事实 id（forget 时必填），先用 list 查看。' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler(args, ctx) {
    if (!ctx.memory) {
      throw new Error('调用了 memory 工具，但 agent 没有配置 memory store (no memory store configured)');
    }
    const action = args.action as string;
    switch (action) {
      case 'list':
        return { items: ctx.memory.list() };
      case 'add': {
        const layer = args.layer as 'identity' | 'preferences' | 'facts' | 'ongoing' | undefined;
        const text = args.text as string | undefined;
        if (!layer) throw new Error('memory.add 需要 layer 参数');
        if (!text || !text.trim()) throw new Error('memory.add 需要非空的 text 参数');
        return { ok: true, added: ctx.memory.add(layer, text) };
      }
      case 'forget': {
        const id = args.id as string | undefined;
        if (!id) throw new Error('memory.forget 需要 id');
        return ctx.memory.forget(id);
      }
      default:
        throw new Error(`未知 action: ${action}`);
    }
  },
};
