/**
 * 账本相关的 prompt 拼装。
 *
 * 三块：
 *   1. buildLedgerInstruction —— system prompt 里追加的"账本维护说明"段。
 *      告诉 LLM 每轮可以在决策 JSON 里加 `ledger_patch: [...]` 字段来更新账本。
 *   2. renderLedgerForPrompt —— 把当前账本序列化成给 LLM 看的人类可读格式。
 *   3. renderPresetFewShot   —— 把 preset 的 example ledger 序列化成 few-shot 示例。
 *
 * 关键取舍：给 LLM 看的**是人类可读的紧凑格式**，不是完整的 JSON。原因：
 *   - JSON 太啰嗦，占 token；条目多了 LLM 看不动
 *   - patch 操作只需要知道 id 就能定位（"我要改 f3 的 status"→ path 是 suggested.findings[f3].status）
 *   - LLM 输出 patch 时用的还是 JSON，输入压缩、输出精确
 */

import type { Ledger, LedgerItem, Preset } from './types.ts';

/** 系统 prompt 里追加的账本维护指令段。 */
export function buildLedgerInstruction(): string {
  return `【会话账本 · Session Ledger】

你维护着一份**会话账本** —— 边干边填的、结构化的会话档案。它取代传统"事后摘要"：
你干活时顺手把关键结论、决策、待办、卡点记进账本，压缩发生时账本本身就是最好的摘要，
会话结束时账本会沉淀成跨会话记忆。

**用 update_ledger 工具维护账本**（它是你可用的工具之一）。可以在同一轮里既调 update_ledger
又调别的工具（并行）。update_ledger 的参数是一组 patch：

  { "op": "add"|"replace"|"remove", "path": "<点号路径>", "value": {...} }

## 路径语法（三层）

  core.intent        —— 会话目标，一句话；第 1 轮就填
  core.state         —— active | wrapping | closed；任务快完时改成 wrapping
  core.language      —— "zh" / "en"

  suggested.<slot>                    —— add 追加一条
  suggested.<slot>[<id>]              —— replace 整条 / remove
  suggested.<slot>[<id>].<subfield>   —— 改某条的 text / status / meta
    slot ∈ progress | findings | decisions | open_threads | blockers | artifacts

  custom.<ns>.<field>                 —— 自由发明命名空间
    例：custom.debug.causal_chain, custom.editing.final_version
    命名规则：<ns> 与 <field> 都匹配 [a-z][a-z0-9_]*

add 到数组时 value 结构：{ "text": "<一句话>", "status"?: "done"|"wip"|..., "meta"?: {...} }
id 由 runtime 自动分配，不用你起。

## 该填什么（按重要性）

- **findings**   值得跨轮引用的结论
- **decisions**  做过的选择（"选 B 不选 A，因为…"）
- **open_threads** 未闭合的线头
- **progress**   已完成的关键动作（只记里程碑，不是每次工具调用都记）
- **blockers**   外部原因卡住的事
- **custom.<ns>.<field>** 槽位不够用时发明命名空间（debug/editing/research…）

不该填：一次性闲聊 / 中间失败分支 / 工具原始输出。

## 时机

- 第 1 轮：先填 core.intent
- 完成显著子步骤：追加 progress / findings
- 做决策时：追加 decisions
- 任务快完 / 用户切话题：core.state 改 wrapping
- 没什么值得记时，就不调 update_ledger`;
}

/**
 * 把账本序列化成"给 LLM 看"的紧凑文本。
 * 空账本返回空字符串（这样 system prompt 里就不会出现空账本占位）。
 */
export function renderLedgerForPrompt(ledger: Ledger): string {
  const lines: string[] = [];
  const c = ledger.core;
  const hasCore = c.intent || c.state !== 'active';
  const enumerate = allArrays(ledger);
  const hasItems = enumerate.some(([, items]) => items.length > 0);

  if (!hasCore && !hasItems) return '';

  lines.push('【当前会话账本】');
  lines.push(`  intent: ${c.intent || '(未填，尽快填一条)'}`);
  lines.push(`  state:  ${c.state}    language: ${c.language}`);

  for (const [path, items] of enumerate) {
    if (!items.length) continue;
    lines.push(`  ${path}:`);
    for (const it of items) {
      const parts = [it.id, it.text];
      if (it.status) parts.push(`[${it.status}]`);
      if (it.archived_ref) parts.push(`(→${it.archived_ref})`);
      lines.push(`    · ${parts.join('  ')}`);
    }
  }
  return lines.join('\n');
}

/** 把 preset 的 example ledger 渲染成 few-shot 示例段。 */
export function renderPresetFewShot(preset: Preset): string {
  const body = renderLedgerForPrompt(preset.example);
  if (!body) return '';
  return [
    `【示例：${preset.name} 类会话的高质量账本形态】`,
    `（示例，仅供参考；本次会话不必和它一致，你可以自由发明适合的自定义命名空间）`,
    '',
    body,
  ].join('\n');
}

function allArrays(ledger: Ledger): Array<[string, LedgerItem[]]> {
  const out: Array<[string, LedgerItem[]]> = [];
  const s = ledger.suggested;
  if (s.progress)     out.push(['suggested.progress', s.progress]);
  if (s.findings)     out.push(['suggested.findings', s.findings]);
  if (s.decisions)    out.push(['suggested.decisions', s.decisions]);
  if (s.open_threads) out.push(['suggested.open_threads', s.open_threads]);
  if (s.blockers)     out.push(['suggested.blockers', s.blockers]);
  if (s.artifacts)    out.push(['suggested.artifacts', s.artifacts]);
  for (const key of Object.keys(ledger.custom).sort()) {
    out.push([`custom.${key}`, ledger.custom[key]]);
  }
  return out;
}
