import { c, symbols } from './ansi.ts';
import { padEndCols, truncateCols } from './width.ts';
import type { Plan, Step } from '../v2/plan.ts';
import type { ExecSpan } from '../v2/executor.ts';
import type { V2Metrics } from '../v2/agent.ts';

/** 用一行 icon 表示 span 状态。 */
function statusIcon(status: ExecSpan['status']): string {
  if (status === 'ok') return c.green(symbols.check);
  if (status === 'failed') return c.red(symbols.cross);
  if (status === 'skipped') return c.gray('·');
  return c.cyan('…');
}

/** 把 Plan 简明地渲染成一段树状文字（planning 阶段结束时展示给用户看）。 */
export function planTree(plan: Plan): string {
  const rows: string[] = [];
  rows.push(c.bold(c.cyan('▸ Plan')) + (plan.thought ? c.dim(`  ${truncateCols(plan.thought, 80)}`) : ''));
  for (const step of plan.steps) {
    rows.push('  ' + renderStepLine(step));
  }
  if (typeof plan.total_budget_ms === 'number') {
    rows.push(c.dim(`  预算: ${plan.total_budget_ms}ms`));
  }
  return rows.join('\n');
}

function renderStepLine(step: Step): string {
  const idc = c.gray(`[${step.id}]`);
  if (step.kind === 'tool') {
    const dep = step.depends_on?.length ? c.dim(` ← ${step.depends_on.join(', ')}`) : '';
    const expect = step.expect ? c.dim(`  expect: ${truncateCols(step.expect, 40)}`) : '';
    return `${idc} ${c.yellow(step.tool)}${dep}${expect}`;
  }
  // respond
  const tag = step.synthesize ? c.bold(c.magenta('respond·synth')) : c.magenta('respond');
  return `${idc} ${tag}`;
}

/**
 * 把 span 流实时渲染成缩进树。plan span 是根，每个 step 是子节点，
 * 每个 expect 是 step 的子节点。传 seen 参数避免同一个 span 打印两次。
 */
export function renderSpan(span: ExecSpan, allSpans: ExecSpan[]): string {
  // 找它在树里的深度（沿着 parent 链走）
  let depth = 0;
  let cur: ExecSpan | undefined = span;
  while (cur?.parent) {
    depth += 1;
    cur = allSpans.find((s) => s.id === cur!.parent);
  }
  const indent = '  '.repeat(Math.max(0, depth));
  const icon = statusIcon(span.status);
  const label = truncateCols(span.name, 80);
  const dur = span.endedAt ? c.dim(`  +${span.endedAt - span.startedAt}ms`) : '';
  const kindC =
    span.kind === 'plan' ? c.cyan :
    span.kind === 'expect' ? c.dim :
    (x: string) => x;
  return `${indent}${icon} ${kindC(label)}${dur}`;
}

export function metricsLine(m: V2Metrics): string {
  return c.dim(
    `${symbols.info}  ` +
    `LLM 调用=${m.llm_calls} ` +
    `(planner=${m.planner_calls}, reflector=${m.reflector_calls}, synth=${m.synth_calls})  ` +
    `校验重试=${m.verify_attempts}  ` +
    `执行重试=${m.execute_attempts}  ` +
    `耗时=${(m.elapsed_ms / 1000).toFixed(2)}s`
  );
}

/** /trace 命令：把整棵 span 树打印出来。 */
export function spanDump(spans: ExecSpan[]): string {
  // 每个 span 会被 emit 两次（开始 + 结束）；只取"完成态"的一份
  const bestById = new Map<string, ExecSpan>();
  for (const s of spans) {
    const prev = bestById.get(s.id);
    if (!prev || (s.endedAt && !prev.endedAt)) bestById.set(s.id, s);
  }
  const finals = Array.from(bestById.values());
  // 拓扑序：先父后子 —— plan 根在最上
  const parentDepth = new Map<string, number>();
  const findDepth = (s: ExecSpan): number => {
    if (parentDepth.has(s.id)) return parentDepth.get(s.id)!;
    if (!s.parent) { parentDepth.set(s.id, 0); return 0; }
    const p = finals.find((x) => x.id === s.parent);
    const d = p ? findDepth(p) + 1 : 0;
    parentDepth.set(s.id, d);
    return d;
  };
  finals.forEach(findDepth);
  finals.sort((a, b) => (a.startedAt - b.startedAt));

  return finals.map((s) => {
    const indent = '  '.repeat(parentDepth.get(s.id) ?? 0);
    const icon = statusIcon(s.status);
    const dur = s.endedAt ? c.dim(`  +${s.endedAt - s.startedAt}ms`) : '';
    return `${indent}${icon} ${padEndCols(s.name, 40)}${dur}`;
  }).join('\n');
}
