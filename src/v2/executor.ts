import type { Plan, ToolStep, RespondStep } from './plan.ts';
import { collectRefs, resolveValue } from './template.ts';
import { evalExpect } from './expect.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { Session } from '../session.ts';

/**
 * span 结构的执行 trace。父子关系构成一棵树，而不是 v1 那种扁平数组。
 * 同一 DAG 层级上互相独立的工具调用是 plan span 下的兄弟节点。
 */
export interface ExecSpan {
  id: string;
  parent?: string;
  kind: 'plan' | 'step' | 'expect' | 'error';
  name: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  detail?: unknown;
}

export interface StepOutcome {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** 若因 expect 断言失败，这里记录失败的表达式。 */
  expect_failed?: string;
}

export interface ExecResult {
  answer: string | null;                          // 由 respond 步骤填充
  outcomes: Record<string, StepOutcome>;
  spans: ExecSpan[];
  /** 若有失败步骤，第一个失败的 step id —— reflector 会把它当作 `from_id`。 */
  failed_step?: string;
  /** 便于 reflector 阅读的失败原因（人可读）。 */
  failure_reason?: string;
}

export interface SynthesizeInput {
  /** planner 写下的、给综合器的短指令。 */
  guidance: string;
  /** 前置步骤的输出，按 step id 索引。 */
  outputs: Record<string, { ok: boolean; result?: unknown; error?: string }>;
  /** 用户原始请求（供综合器 LLM 使用）。 */
  userInput?: string;
}

export interface ExecOptions {
  /** 并发上限。默认 4。 */
  maxConcurrency?: number;
  /** 每个 span 开始 / 结束时都会触发一次。 */
  onSpan?: (span: ExecSpan) => void;
  /**
   * 仅当有 respond 步骤设置了 `synthesize: true` 时才需要提供。
   * executor 会把 (guidance + outputs) 交给它，由它产出最终文本。
   * runtime 不关心底层 LLM 是什么，由调用方注入。
   */
  synthesize?: (input: SynthesizeInput) => Promise<string>;
  /** 会作为 `userInput` 一起传给 synthesizer。 */
  userInput?: string;
  /**
   * 工具执行前的钩子。返回 false 会把该 step 记为"被拒绝"（走失败分支，
   * reflector 会拿到 outcome 尝试修补）。用来做审批门。
   */
  beforeTool?: (info: { tool: string; args: Record<string, unknown>; stepId: string }) => Promise<boolean>;
}

function nowMs(): number { return Date.now(); }
function mkSpanId(): string { return Math.random().toString(36).slice(2, 10); }

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）：${label}`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * DAG 执行器。依赖已满足的步骤会并行执行（并发上限由 maxConcurrency 控制）。
 * 每一步执行完毕先检查后置断言，通过后才把结果暴露给下游步骤。
 *
 * 一旦有步骤失败，就停止启动新工作、等待已在进行中的步骤结束、然后带着
 * `failed_step` 返回。V2Agent 会据此调 reflector 拿一个 PlanPatch 拼进来。
 */
export async function executePlan(
  plan: Plan,
  registry: ToolRegistry,
  session: Session,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const maxConc = opts.maxConcurrency ?? 4;
  const spans: ExecSpan[] = [];
  const emit = (s: ExecSpan) => {
    spans.push(s);
    opts.onSpan?.(s);
  };

  const planSpan: ExecSpan = {
    id: mkSpanId(), kind: 'plan', name: 'plan', startedAt: nowMs(), status: 'running',
    detail: { steps: plan.steps.length },
  };
  emit(planSpan);

  const outcomes: Record<string, StepOutcome> = {};
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));

  // 计算每个 step 的依赖集（depends_on + args 里的引用）。
  const deps = new Map<string, Set<string>>();
  for (const step of plan.steps) {
    const d = new Set<string>();
    for (const x of step.depends_on ?? []) d.add(x);
    if (step.kind === 'tool') collectRefs(step.args, d);
    if (step.kind === 'respond') collectRefs(step.template, d);
    d.delete(step.id);
    deps.set(step.id, d);
  }

  const pending = new Set<string>(plan.steps.map((s) => s.id));
  const running = new Map<string, Promise<void>>();
  let firstFailure: { id: string; reason: string } | undefined;
  let answer: string | null = null;

  const canStart = (id: string): boolean => {
    if (running.has(id) || !pending.has(id)) return false;
    for (const d of deps.get(id)!) {
      if (!outcomes[d]) return false;
      if (!outcomes[d].ok) return false; // 上游失败 → 不启动
    }
    return true;
  };

  const runToolStep = async (step: ToolStep, parent: string): Promise<StepOutcome> => {
    const span: ExecSpan = {
      id: mkSpanId(), parent, kind: 'step', name: `${step.tool} (${step.id})`,
      startedAt: nowMs(), status: 'running', detail: { tool: step.tool },
    };
    emit(span);

    try {
      const resolvedArgs = resolveValue(step.args, { outputs: outcomes }) as Record<string, unknown>;

      // 审批钩子：若返回 false，把该 step 视为失败（"用户拒绝"）
      if (opts.beforeTool) {
        const ok = await opts.beforeTool({ tool: step.tool, args: resolvedArgs, stepId: step.id });
        if (!ok) {
          span.endedAt = nowMs();
          span.status = 'failed';
          span.detail = { tool: step.tool, error: 'denied' };
          emit(span);
          return { id: step.id, ok: false, error: '用户拒绝了本次工具调用' };
        }
      }

      const invocation = registry.invoke(step.tool, resolvedArgs, {
        sessionId: session.id,
        sessionState: session.state,
        logger: () => {},
      });
      const budget = step.budget_ms ?? 30_000;
      const result = await withTimeout(Promise.resolve(invocation), budget, `${step.tool}(${step.id})`);

      // 后置断言
      if (step.expect) {
        const espan: ExecSpan = {
          id: mkSpanId(), parent: span.id, kind: 'expect', name: `expect: ${step.expect}`,
          startedAt: nowMs(), status: 'running',
        };
        emit(espan);
        const passed = evalExpect(step.expect, { result, args: resolvedArgs, step_id: step.id });
        espan.endedAt = nowMs();
        espan.status = passed ? 'ok' : 'failed';
        emit(espan);
        if (!passed) {
          span.endedAt = nowMs();
          span.status = 'failed';
          emit(span);
          return { id: step.id, ok: false, result, error: `expect 断言失败：${step.expect}`, expect_failed: step.expect };
        }
      }

      span.endedAt = nowMs();
      span.status = 'ok';
      span.detail = { tool: step.tool, ok: true };
      emit(span);
      return { id: step.id, ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      span.endedAt = nowMs();
      span.status = 'failed';
      span.detail = { tool: step.tool, error: msg };
      emit(span);
      return { id: step.id, ok: false, error: msg };
    }
  };

  const runRespondStep = async (step: RespondStep, parent: string): Promise<StepOutcome> => {
    const span: ExecSpan = {
      id: mkSpanId(), parent, kind: 'step',
      name: step.synthesize ? `respond·synth (${step.id})` : `respond (${step.id})`,
      startedAt: nowMs(), status: 'running',
      detail: { synthesize: Boolean(step.synthesize) },
    };
    emit(span);
    try {
      if (step.synthesize) {
        if (!opts.synthesize) {
          throw new Error(`respond 步骤 "${step.id}" 声明了 synthesize=true，但没有提供 synthesizer`);
        }
        // 只把本 respond 真正引用到的 step 输出交给 synthesizer，尽量保持轻量。
        const refIds = new Set<string>();
        collectRefs(step.template, refIds);
        const refOutputs: Record<string, typeof outcomes[string]> = {};
        for (const id of refIds) if (outcomes[id]) refOutputs[id] = outcomes[id];
        answer = await opts.synthesize({
          guidance: step.template,
          outputs: refOutputs,
          userInput: opts.userInput,
        });
      } else {
        const text = resolveValue(step.template, { outputs: outcomes });
        answer = typeof text === 'string' ? text : JSON.stringify(text);
      }
      span.endedAt = nowMs(); span.status = 'ok';
      emit(span);
      return { id: step.id, ok: true, result: answer };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      span.endedAt = nowMs(); span.status = 'failed'; span.detail = { error: msg };
      emit(span);
      return { id: step.id, ok: false, error: msg };
    }
  };

  const startStep = (id: string): void => {
    const step = stepById.get(id)!;
    pending.delete(id);
    const parent = planSpan.id;
    const runner = step.kind === 'tool'
      ? runToolStep(step as ToolStep, parent)
      : runRespondStep(step as RespondStep, parent);
    const p = runner.then((outcome) => {
      outcomes[id] = outcome;
      if (!outcome.ok && !firstFailure) {
        firstFailure = { id, reason: outcome.error ?? '未知失败' };
      }
      running.delete(id);
    });
    running.set(id, p);
  };

  // 调度主循环
  const totalStart = nowMs();
  const totalBudget = plan.total_budget_ms ?? 120_000;
  while (pending.size > 0 || running.size > 0) {
    if (nowMs() - totalStart > totalBudget) {
      firstFailure ??= { id: [...pending][0] ?? 'plan', reason: `total_budget_ms (${totalBudget}) 超时` };
      break;
    }
    if (firstFailure) {
      // 出现失败后：不再启动新步骤；等在进行中的步骤自然收尾。
      if (running.size === 0) break;
      await Promise.race(running.values());
      continue;
    }
    // 尽量多启动可运行的步骤。
    let launched = 0;
    for (const id of [...pending]) {
      if (running.size >= maxConc) break;
      if (canStart(id)) { startStep(id); launched++; }
    }
    if (launched === 0) {
      if (running.size === 0) break; // 死锁 —— verifier 通过的话不该出现
      await Promise.race(running.values());
    } else {
      // 让 event loop 走一拍，好让 `running` 里的 promise 就位
      await Promise.resolve();
    }
  }
  // 收尾：等所有在跑的都结束。
  while (running.size > 0) await Promise.race(running.values());

  planSpan.endedAt = nowMs();
  planSpan.status = firstFailure ? 'failed' : 'ok';
  emit(planSpan);

  return {
    answer,
    outcomes,
    spans,
    failed_step: firstFailure?.id,
    failure_reason: firstFailure?.reason,
  };
}
