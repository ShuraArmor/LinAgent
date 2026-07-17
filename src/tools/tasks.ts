/**
 * 后台任务工具集 —— agent 用它把慢工具丢后台，避免卡死对话。
 *
 *   spawn_task  把一个白名单工具转发到后台跑（先同步等宽限期，超时才转后台）
 *   check_task  按 id 查状态/结果
 *   list_tasks  列出本会话的任务
 *   cancel_task 取消（进程类能真 kill，纯 promise 只标记忽略）
 *
 * 约束：
 *   - 只允许转发 SPAWNABLE 白名单里的慢工具（防止把 update_ledger 之类也丢后台）。
 *   - 禁止 spawn_task 套 spawn_task（防递归）。
 * handle 由 ctx.tasks 注入（agent.ts 挂当前 session 的 BackgroundTaskManager）。
 */

import type { Tool, TaskStatus } from '../types.ts';

/** 允许被 spawn 到后台的工具白名单 —— 只有真正可能慢的才有意义。 */
export const SPAWNABLE_TOOLS = new Set<string>(['bash_exec', 'run_workflow']);

export const spawnTaskTool: Tool = {
  name: 'spawn_task',
  description:
    '把一个可能很慢的工具丢到后台异步执行，不阻塞对话。' +
    '会先同步等一小段时间（宽限期），若在宽限期内完成就直接返回结果；' +
    '否则返回 task_id，任务在后台继续跑，完成后会在下一轮对话里通知你，' +
    '你也可以用 check_task 主动查询。' +
    `只能转发这些工具：${[...SPAWNABLE_TOOLS].join(' / ')}。`,
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: `要后台执行的工具名（白名单：${[...SPAWNABLE_TOOLS].join('/')}）` },
      args: { type: 'object', description: '传给该工具的参数对象' },
      label: { type: 'string', description: '人类可读的任务描述，如 "跑完整测试套件"' },
      wait_ms: { type: 'integer', description: '可选：同步宽限期毫秒数，默认 5000。设 0 表示立即转后台。' },
    },
    required: ['tool', 'args', 'label'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!ctx.tasks) return { ok: false, error: '当前 agent 未启用后台任务能力' };
    const tool = String(args.tool ?? '');
    if (tool === 'spawn_task') return { ok: false, error: '不能递归 spawn_task' };
    if (!SPAWNABLE_TOOLS.has(tool)) {
      return { ok: false, error: `工具 "${tool}" 不在可后台执行的白名单里（${[...SPAWNABLE_TOOLS].join('/')}）` };
    }
    const label = String(args.label ?? tool);
    const graceMs = typeof args.wait_ms === 'number' ? args.wait_ms : undefined;
    const r = await ctx.tasks.spawn(tool, args.args ?? {}, label, graceMs);
    if (r.status === 'running') {
      return { ok: true, status: 'running', task_id: r.task_id,
        note: `任务在后台执行中，完成后下一轮会通知你，或用 check_task("${r.task_id}") 查询。` };
    }
    if (r.status === 'done') return { ok: true, status: 'done', result: r.result };
    return { ok: false, status: 'failed', error: r.error };
  },
};

export const checkTaskTool: Tool = {
  name: 'check_task',
  description: '查询一个后台任务的当前状态；若已完成，返回其结果。',
  parameters: {
    type: 'object',
    properties: { task_id: { type: 'string', description: '任务 id，形如 t-1a' } },
    required: ['task_id'],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    if (!ctx.tasks) return { ok: false, error: '当前 agent 未启用后台任务能力' };
    const t = ctx.tasks.check(String(args.task_id ?? ''));
    if (!t) return { ok: false, error: `未找到任务 ${args.task_id}` };
    return {
      ok: true, id: t.id, label: t.label, status: t.status,
      result: t.status === 'done' ? t.result : undefined,
      error: t.status === 'failed' ? t.error : undefined,
    };
  },
};

export const listTasksTool: Tool = {
  name: 'list_tasks',
  description: '列出本会话的后台任务（可按状态过滤）。',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['running', 'done', 'failed', 'interrupted', 'canceled'],
        description: '可选：只列这个状态的任务' },
    },
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    if (!ctx.tasks) return { ok: false, error: '当前 agent 未启用后台任务能力' };
    const status = args.status as TaskStatus | undefined;
    const tasks = ctx.tasks.list(status).map((t) => ({
      id: t.id, label: t.label, tool: t.tool, status: t.status,
    }));
    return { ok: true, count: tasks.length, tasks };
  },
};

export const cancelTaskTool: Tool = {
  name: 'cancel_task',
  description: '取消一个仍在运行的后台任务。',
  parameters: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    if (!ctx.tasks) return { ok: false, error: '当前 agent 未启用后台任务能力' };
    return ctx.tasks.cancel(String(args.task_id ?? ''));
  },
};

export const taskTools: Tool[] = [spawnTaskTool, checkTaskTool, listTasksTool, cancelTaskTool];
