/**
 * update_ledger 工具 —— agent 通过原生工具调用维护会话账本。
 *
 * 取代旧的"决策 JSON 里搭车 ledger_patch 字段"。原生工具协议下账本更新变成一个
 * first-class 工具:agent 想改账本就调它,配合并行工具调用,一轮可以同时
 * update_ledger + 调真工具。
 *
 * handler 需要拿到"当前会话的账本 + store"来应用 patch。这通过 ToolContext 上
 * 挂的 ledger handle 注入(见 types.ts LedgerHandle + agent.ts 接线)。
 */

import type { Tool } from '../types.ts';
import type { LedgerPatch } from './types.ts';

export const updateLedgerTool: Tool = {
  name: 'update_ledger',
  description:
    '更新会话账本 —— 把关键结论、决策、待办、卡点记进结构化的会话档案。' +
    '账本会在压缩时替代摘要、在会话结束时沉淀成跨会话记忆。' +
    '每完成一个显著子步骤、做出决策、或发现值得跨轮引用的结论时调用。',
  parameters: {
    type: 'object',
    properties: {
      patches: {
        type: 'array',
        description:
          '一组账本补丁。每条 { op, path, value }：\n' +
          'op: "add"(数组追加一条) | "replace"(覆盖) | "remove"(删除)\n' +
          'path 点号路径:\n' +
          '  core.intent | core.state(active|wrapping|closed) | core.language\n' +
          '  suggested.<slot>  slot ∈ progress|findings|decisions|open_threads|blockers|artifacts\n' +
          '  suggested.<slot>[<id>]  或  suggested.<slot>[<id>].<subfield>\n' +
          '  custom.<ns>.<field>  (可自由发明命名空间,如 custom.debug.causal_chain)\n' +
          'value: add 到数组时是 { text, status?, meta? };改字段时是目标值。\n' +
          '任务快结束时把 core.state 改成 wrapping。',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'replace', 'remove'] },
            path: { type: 'string' },
            value: {
              // 不标 type —— value 可能是字符串或对象，取决于 path：
              //  · core.intent / core.state / core.language / preset_used / *.status / *.text
              //    → 字符串，如 value: "部署项目"
              //  · add 到数组（suggested.<slot> / custom.<ns>.<field>）
              //    → 对象，如 value: { "text": "...", "status": "wip" }
              description:
                'patch 的值。字符串 or 对象，取决于 path：' +
                'core.intent/core.state/core.language/preset_used 以及改 [id].status/.text 时是【字符串】；' +
                'add 到数组（suggested.<slot> 或 custom.<ns>.<field>）时是【对象】{text, status?, meta?}。',
            },
          },
          required: ['op', 'path'],
        },
      },
    },
    required: ['patches'],
    additionalProperties: false,
  },
  handler: (args, ctx) => {
    if (!ctx.ledger) {
      return { ok: false, error: '当前会话未启用账本' };
    }
    const patches = Array.isArray(args.patches) ? (args.patches as LedgerPatch[]) : [];
    if (!patches.length) return { ok: false, error: 'patches 为空' };
    const report = ctx.ledger.applyPatches(patches);
    return {
      ok: true,
      applied: report.applied,
      failed: report.failed,
      assigned_ids: report.assigned_ids,
    };
  },
};
