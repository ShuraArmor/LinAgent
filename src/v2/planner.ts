import type { LLMClient, Message } from '../types.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { Plan, PlanPatch } from './plan.ts';
import type { ExecResult } from './executor.ts';

export class PlannerError extends Error {}

/**
 * Planner 与 LLM 的契约跟 v1 明显不同：
 *   v1：每一轮让 LLM 选一个动作 —— 决策 + 执行 + 叙述都揉在一起
 *   v2：一次性给出整份 Plan（JSON），交给确定性 runtime 去执行
 *
 * 正常路径下每个用户轮次只调用一次 LLM。剩下的（校验、并行执行、后置断言）
 * 全部由代码完成。
 */
export function plannerSystemPrompt(registry: ToolRegistry): string {
  return `你是 LinAgent 的 Planner。你只做规划，不负责执行。
你的输出是一份 Plan —— 一个由步骤组成的小 DAG，会由确定性 runtime 去执行。

可用工具（可以随意调用，同一工具也可多次调用）：
${registry.describeAll()}

输出规则（严格）：
- 只输出一个 JSON 对象，前后不加任何文字，不加代码围栏。
- 结构：
{
  "thought": "<一两句高层推理>",
  "steps": [
    { "id": "s1", "kind": "tool", "tool": "weather", "args": {"city": "Beijing"},
      "expect": "result.available == true", "budget_ms": 5000 },
    { "id": "s2", "kind": "tool", "tool": "todo",
      "args": {"action": "add", "text": "带伞"},
      "depends_on": ["s1"], "expect": "result.ok == true" },
    { "id": "final", "kind": "respond",
      "template": "北京：{{s1.result.condition}}，{{s1.result.temperature.low}}-{{s1.result.temperature.high}}°{{s1.result.temperature.unit}}。已加待办 #{{s2.result.added.id}}。" }
  ],
  "total_budget_ms": 30000
}

规则：
- 每个 plan 必须恰好包含一个 "respond" 步骤，且它必须是拓扑顺序的最后一步。
- 引用前面步骤的结果时，在 args 或 respond 模板里写 {{step_id.path.to.value}}。
- 相互独立的步骤（没有数据依赖）不要互相列入 depends_on —— runtime 会自动并行。
- "expect" 是一个可选的**形式化布尔表达式**，用一个受限 DSL 写，由代码解析求值 ——
  **不是自然语言、不是描述、也不是中文**。作用对象是该步骤的 { result, args }。
  * 支持的操作符：==, !=, <, <=, >, >=, +, -, *, /, &&, ||, !, len(x)
  * 支持的字面量：数字、双引号字符串、true / false / null
  * 支持的路径：result.a.b、args.x、result.list[0].name 之类的点/下标访问
  * 正确示例：
      "result.ok == true"
      "result.available == true"
      "len(result.results) > 0"
      "result.temperature.high < 40"
      "result.available == true && len(result.results) > 0"
  * **绝对错误的示例**（会被 verifier 拒绝，reflector 陷入死循环）：
      "result 有至少一个 item"        ← 中文描述
      "结果非空"                       ← 中文描述
      "check result.list is nonempty"  ← 英文描述
      "result.list != []"              ← 不支持数组字面量
  * 如果一个校验没法用 DSL 写清楚，**就完全省略 expect 字段**，别用自然语言凑。
- 计划要尽量小，不要加探索性或防御性的多余步骤。
- 如果用户的问题纯粹是闲聊、不需要工具，只输出一个 "respond" 步骤。

RESPOND 步骤 —— "synthesize" 开关：
- 默认 "synthesize" 为 false（或省略），此时模板走纯字符串替换 —— 适合"把已知值拼起来"这类场景。
- 只有当最终回答需要跨多个步骤结果做推理（比较"谁最热"、排序、按条件过滤、跨工具聚合、对工具输出做自由总结）
  且静态模板无法胜任时，才把 "synthesize" 设为 true。
- 此时 "template" 变成给"综合器 LLM"的简短指令（例如："比较四个城市的最高温，用一句中文说出哪座最热"）。
  依然允许在指令里用 {{step.result.x}}，被引用步骤的输出会一并交给综合器。
- 模板能搞定的场景绝对不要用 synthesize=true —— 会多花一次 LLM 调用。

需要 synthesize 的示例：
{
  "steps": [
    { "id": "a", "kind": "tool", "tool": "weather", "args": {"city":"Beijing"} },
    { "id": "b", "kind": "tool", "tool": "weather", "args": {"city":"Shanghai"} },
    { "id": "c", "kind": "tool", "tool": "weather", "args": {"city":"Hangzhou"} },
    { "id": "d", "kind": "tool", "tool": "weather", "args": {"city":"Shenzhen"} },
    { "id": "final", "kind": "respond", "synthesize": true,
      "template": "比较 {{a.result}}、{{b.result}}、{{c.result}}、{{d.result}}，用一句中文说出今天哪座城市最热。" }
  ]
}`;
}

const JSON_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** 从模型输出中定位一个平衡花括号的 JSON 对象，容忍前后的多余文本或代码围栏。 */
function extractJson(raw: string): string {
  let s = raw.trim();
  const m = s.match(JSON_FENCE_RE);
  if (m) s = m[1].trim();
  const start = s.indexOf('{');
  if (start < 0) throw new PlannerError('planner 输出中没有找到 JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  throw new PlannerError('planner 输出的 JSON 花括号不平衡');
}

export interface PlannerContext {
  history: Message[];
  onDelta?: (chunk: string) => void;
}

export async function plan(
  llm: LLMClient,
  registry: ToolRegistry,
  ctx: PlannerContext,
): Promise<{ plan: Plan; raw: string }> {
  const messages: Message[] = [
    { role: 'system', content: plannerSystemPrompt(registry) },
    ...ctx.history,
  ];
  const raw = await llm.chat(messages, { temperature: 0.1, onDelta: ctx.onDelta });
  const jsonText = extractJson(raw);
  let obj: unknown;
  try { obj = JSON.parse(jsonText); }
  catch (err) { throw new PlannerError(`planner 输出解析 JSON 失败：${(err as Error).message}`); }
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as Plan).steps)) {
    throw new PlannerError('planner 输出缺少 "steps" 数组');
  }
  return { plan: obj as Plan, raw };
}

// ─── Reflector ──────────────────────────────────────────────────────────

function reflectorSystemPrompt(registry: ToolRegistry): string {
  return `你是 LinAgent 的 Reflector。刚才有一份 plan 在执行过程中失败了。
你的任务：产出一个 PlanPatch —— 用一段新的步骤序列替换失败步骤及其后续。

可用工具：
${registry.describeAll()}

输出规则（严格）：
- 只输出一个 JSON 对象，前后不加任何文字，不加代码围栏。
- 结构：
{
  "thought": "<失败原因，以及此 patch 为什么能修复>",
  "from_id": "<失败步骤在上一份 plan 中的 id>",
  "new_steps": [
    { "id": "s2b", "kind": "tool", "tool": "...", "args": {...}, "expect": "..." },
    { "id": "final", "kind": "respond", "template": "..." }
  ]
}

规则：
- patch 必须以 "respond" 步骤结尾（规则跟 planner 一致）。
- 可以起新的 step id，但不要复用失败 plan 里已有的 id。
- patch 要小 —— 不要从头重新规划整件事。
- **"expect" 字段是形式化布尔表达式，不是自然语言**。只允许：
    * 操作符：==, !=, <, <=, >, >=, +, -, *, /, &&, ||, !, len(x)
    * 字面量：数字、双引号字符串、true / false / null
    * 路径：result.a.b、args.x、result.list[0].name
    * 例：result.ok == true   |   len(result.results) > 0   |   result.temperature.high < 40
  写中文描述（如 "result 有至少一个 item"）会被 verifier 直接拒绝，
  patch 白白浪费。如果 expect 表达不出来，**就省略这个字段**。`;
}

export interface ReflectorContext {
  history: Message[];
  previousPlan: Plan;
  execResult: ExecResult;
  onDelta?: (chunk: string) => void;
}

export async function reflect(
  llm: LLMClient,
  registry: ToolRegistry,
  ctx: ReflectorContext,
): Promise<{ patch: PlanPatch; raw: string }> {
  const failure = {
    failed_step: ctx.execResult.failed_step,
    failure_reason: ctx.execResult.failure_reason,
    outcomes: ctx.execResult.outcomes,
  };
  const messages: Message[] = [
    { role: 'system', content: reflectorSystemPrompt(registry) },
    ...ctx.history,
    {
      role: 'user',
      content:
        `上一份 plan：\n${JSON.stringify(ctx.previousPlan, null, 2)}\n\n` +
        `执行结果：\n${JSON.stringify(failure, null, 2)}\n\n` +
        `请按上面的规则输出一份 PlanPatch JSON。`,
    },
  ];
  const raw = await llm.chat(messages, { temperature: 0.2, onDelta: ctx.onDelta });
  const jsonText = extractJson(raw);
  let obj: unknown;
  try { obj = JSON.parse(jsonText); }
  catch (err) { throw new PlannerError(`reflector 输出解析 JSON 失败：${(err as Error).message}`); }
  if (!obj || typeof obj !== 'object'
      || typeof (obj as PlanPatch).from_id !== 'string'
      || !Array.isArray((obj as PlanPatch).new_steps)) {
    throw new PlannerError('reflector 输出缺少 "from_id" 或 "new_steps"');
  }
  return { patch: obj as PlanPatch, raw };
}

/** 应用 patch：保留 `from_id` 之前的所有步骤，把 `new_steps` 追加上去。 */
export function applyPatch(base: Plan, patch: PlanPatch): Plan {
  const idx = base.steps.findIndex((s) => s.id === patch.from_id);
  const prefix = idx >= 0 ? base.steps.slice(0, idx) : base.steps.slice();
  return {
    thought: patch.thought ?? base.thought,
    steps: [...prefix, ...patch.new_steps],
    total_budget_ms: base.total_budget_ms,
  };
}
