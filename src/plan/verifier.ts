import type { Plan, Step } from './plan.ts';
import { collectRefs } from './template.ts';
import { parseExpect } from './expect.ts';
import { validateArgs } from '../tools/registry.ts';
import type { ToolRegistry } from '../tools/registry.ts';

export class PlanVerifyError extends Error {
  constructor(public readonly summary: string, public readonly issues: string[]) {
    super(`${summary}: ${issues.join('; ')}`);
  }
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface VerifyResult {
  order: string[]; // step id 的拓扑顺序
}

/**
 * 在 executor 执行之前做的静态检查：
 *   1. 基础结构：steps 非空、id 合法且唯一
 *   2. 必须恰好有一个 `respond` 步骤，且它在拓扑顺序里必须是最后
 *   3. 所有 tool 名字必须已注册
 *   4. 每个 step 的 args 必须匹配 tool 的 JSON schema
 *      （若 args 里含模板引用则跳过 —— 在运行时才能校验）
 *   5. 每个 `depends_on` 与 args / template 中的引用都必须指向已知 step
 *   6. 无环
 *   7. 每个 `expect` DSL 表达式都必须语法正确
 *   8. 若设置了 total_budget_ms，则 sum(step.budget_ms) 不能超过它
 */
export function verifyPlan(plan: Plan, registry: ToolRegistry): VerifyResult {
  const issues: string[] = [];
  const push = (m: string) => issues.push(m);

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new PlanVerifyError('plan 至少需要一个步骤', ['empty plan']);
  }

  // (1) id 合法且唯一
  const idSet = new Set<string>();
  for (const step of plan.steps) {
    if (typeof step.id !== 'string' || !ID_RE.test(step.id)) push(`非法 step id: ${JSON.stringify(step.id)}`);
    if (idSet.has(step.id)) push(`重复的 step id: ${step.id}`);
    idSet.add(step.id);
  }

  // (2) 恰好一个 respond 步骤，且 template 非空
  const respondSteps = plan.steps.filter((s): s is Extract<Step, { kind: 'respond' }> => s.kind === 'respond');
  if (respondSteps.length !== 1) push(`plan 必须恰好包含一个 respond 步骤（当前有 ${respondSteps.length} 个）`);
  for (const r of respondSteps) {
    if (typeof r.template !== 'string' || !r.template.trim()) {
      push(`respond 步骤 "${r.id}" 的 template 为空 (empty template)`);
    }
    if (r.synthesize) {
      const refs = new Set<string>();
      collectRefs(r.template, refs);
      if (refs.size === 0) {
        push(`respond 步骤 "${r.id}" 的 synthesize=true 但未引用任何前置步骤 —— synthesize 需要素材才能推理`);
      }
    }
  }

  // (3)+(4) tool 存在 + 无引用时的 args schema 校验
  for (const step of plan.steps) {
    if (step.kind !== 'tool') continue;
    if (!registry.has(step.tool)) { push(`未知的工具 (unknown tool): ${step.tool} (step ${step.id})`); continue; }
    const hasRefs = collectRefs(step.args).size > 0;
    if (!hasRefs) {
      try { validateArgs(registry.get(step.tool).parameters, step.args); }
      catch (err) { push(`step ${step.id}: ${(err as Error).message}`); }
    }
  }

  // (5) 引用必须指向已知 step
  for (const step of plan.steps) {
    const refs = new Set<string>();
    if (step.kind === 'tool') collectRefs(step.args, refs);
    if (step.kind === 'respond') collectRefs(step.template, refs);
    for (const r of refs) {
      if (!idSet.has(r)) push(`step ${step.id} 引用了未知 step (unknown step) "${r}"`);
    }
    for (const d of step.depends_on ?? []) {
      if (!idSet.has(d)) push(`step ${step.id} 依赖未知 step "${d}"`);
    }
  }

  // (7) expect 语法
  for (const step of plan.steps) {
    if (step.kind === 'tool' && step.expect) {
      try { parseExpect(step.expect); }
      catch (err) { push(`step ${step.id}: expect syntax 错误 — ${(err as Error).message}`); }
    }
  }

  // 根据 depends_on + args 引用构造入度表，用于拓扑检查。
  // respond 步骤隐式依赖 plan 里所有其它 step —— 语义上它就是"总结"，必须最后跑。
  // 这样用户不必手工列出一堆 depends_on。
  const inbound: Record<string, Set<string>> = {};
  for (const step of plan.steps) {
    const deps = new Set<string>();
    for (const d of step.depends_on ?? []) deps.add(d);
    if (step.kind === 'tool') collectRefs(step.args, deps);
    if (step.kind === 'respond') {
      collectRefs(step.template, deps);
      // 让 respond 隐式依赖所有其它步骤
      for (const other of plan.steps) if (other.id !== step.id) deps.add(other.id);
    }
    // step 不会依赖自己。
    deps.delete(step.id);
    // 只保留已知 id，避免"未知引用"错误又被"存在环"错误重复报一次。
    inbound[step.id] = new Set([...deps].filter((d) => idSet.has(d)));
  }

  // (6) 拓扑排序 —— Kahn 算法；若无法排出所有节点，说明存在环 (cycle)。
  const order: string[] = [];
  const remainingIn: Record<string, number> = {};
  for (const [id, deps] of Object.entries(inbound)) remainingIn[id] = deps.size;
  const queue: string[] = Object.entries(remainingIn).filter(([, n]) => n === 0).map(([id]) => id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const step of plan.steps) {
      if (inbound[step.id].has(id)) {
        inbound[step.id].delete(id);
        remainingIn[step.id] -= 1;
        if (remainingIn[step.id] === 0) queue.push(step.id);
      }
    }
  }
  if (order.length !== plan.steps.length) {
    const stuck = plan.steps.map((s) => s.id).filter((id) => !order.includes(id));
    push(`步骤间存在环 (cycle): ${stuck.join(', ')}`);
  } else {
    // (2 续) respond 必须是拓扑最后一步
    const respondId = respondSteps[0]?.id;
    if (respondId && order[order.length - 1] !== respondId) {
      push(`respond 步骤 "${respondId}" 必须是终止步骤；有其它步骤依赖了它之后的结果`);
    }
  }

  // (8) 预算 (budget)
  if (typeof plan.total_budget_ms === 'number') {
    let sum = 0;
    for (const s of plan.steps) if (s.kind === 'tool' && typeof s.budget_ms === 'number') sum += s.budget_ms;
    if (sum > plan.total_budget_ms) push(`步骤 budget 之和 (${sum}ms) 超过 total_budget_ms (${plan.total_budget_ms}ms)`);
  }

  if (issues.length) throw new PlanVerifyError(`计划校验失败，共 ${issues.length} 处问题`, issues);
  return { order };
}
