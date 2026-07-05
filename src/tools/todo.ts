import type { Tool, ToolContext } from '../types.ts';

interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: number;
}

interface TodoState {
  items: TodoItem[];
  nextId: number;
}

function getState(ctx: ToolContext): TodoState {
  let state = ctx.sessionState.todos as TodoState | undefined;
  if (!state) {
    state = { items: [], nextId: 1 };
    ctx.sessionState.todos = state;
  }
  return state;
}

export const todoTool: Tool = {
  name: 'todo',
  description:
    '管理当前会话的待办列表。动作：add(text)、list()、done(id)、remove(id)、clear()。todo 按会话隔离。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'done', 'remove', 'clear'],
        description: '要执行的操作。',
      },
      text: { type: 'string', description: '待办文本（用于 add）。' },
      id: { type: 'integer', description: '待办 id（用于 done/remove）。' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler(args, ctx) {
    const state = getState(ctx);
    const action = args.action as string;
    switch (action) {
      case 'add': {
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('todo.add 需要非空 text');
        const item: TodoItem = { id: state.nextId++, text, done: false, createdAt: Date.now() };
        state.items.push(item);
        return { ok: true, added: item, total: state.items.length };
      }
      case 'list':
        return { items: state.items, total: state.items.length };
      case 'done': {
        const id = args.id as number | undefined;
        if (typeof id !== 'number') throw new Error('todo.done 需要数字 id');
        const item = state.items.find((x) => x.id === id);
        if (!item) return { ok: false, error: `未找到 id 为 ${id} 的待办` };
        item.done = true;
        return { ok: true, item };
      }
      case 'remove': {
        const id = args.id as number | undefined;
        if (typeof id !== 'number') throw new Error('todo.remove 需要数字 id');
        const idx = state.items.findIndex((x) => x.id === id);
        if (idx < 0) return { ok: false, error: `未找到 id 为 ${id} 的待办` };
        const [removed] = state.items.splice(idx, 1);
        return { ok: true, removed };
      }
      case 'clear': {
        const n = state.items.length;
        state.items = [];
        state.nextId = 1;
        return { ok: true, cleared: n };
      }
      default:
        throw new Error(`未知 action: ${action}`);
    }
  },
};
