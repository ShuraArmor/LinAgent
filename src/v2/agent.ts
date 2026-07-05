import type { LLMClient, Message } from '../types.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { Session } from '../session.ts';
import type { Plan } from './plan.ts';
import { plan as callPlanner, reflect as callReflector, applyPatch, PlannerError } from './planner.ts';
import { verifyPlan, PlanVerifyError } from './verifier.ts';
import { executePlan, type ExecSpan } from './executor.ts';
import {
  compressIfNeeded, DEFAULT_CONTEXT_CONFIG,
  heuristicSummarize, llmSummarize,
  type ContextConfig,
} from '../context.ts';

export interface V2Metrics {
  llm_calls: number;
  planner_calls: number;
  reflector_calls: number;
  synth_calls: number;
  verify_attempts: number;
  execute_attempts: number;
  elapsed_ms: number;
}

export interface V2Result {
  answer: string;
  plan: Plan;
  spans: ExecSpan[];
  metrics: V2Metrics;
}

export interface V2Options {
  /** 允许 reflector 修补失败 plan 的最大次数，默认 2。 */
  maxReflections?: number;
  /** verifier 拒绝时允许重新规划的最大次数，默认 2。 */
  maxVerifyRetries?: number;
  onSpan?: (span: ExecSpan) => void;
  onDelta?: (chunk: string, phase: 'planner' | 'reflector') => void;
  /**
   * 上下文压缩配置。默认与 v1 一致（maxMessages=24, keepRecent=8）。
   * 若历史超过阈值，会把最老的一段折进一条 system 摘要，防止长会话把 planner
   * 的 prompt 撑爆。传 null 显式关闭压缩。
   */
  context?: ContextConfig | null;
  /** true 时用 LLM 做摘要，false 走启发式版本。默认 true。 */
  useLLMCompression?: boolean;
}

/**
 * v2 Agent —— planner / executor 分离。
 *
 * 单个用户轮次的流程：
 *   1. Planner（LLM，1 次调用）：产出一份 Plan JSON。
 *   2. Verifier（纯代码）：schema + DAG + 预算 + 工具存在 + expect 语法 等。
 *      失败时把问题清单追加给 planner 让它重来（最多 maxVerifyRetries 次）。
 *   3. Executor（纯代码）：执行 DAG，能并行的就并行，每步检查 expect。
 *   4. Reflector（LLM，只有在有步骤失败时才被唤醒）：产出一个 PlanPatch。
 *      应用 patch、再校验、再执行（最多 maxReflections 次）。
 *
 * 正常路径下每轮只调用一次 LLM（一条工具链不再需要额外的 completion）。
 * 而 v1 里 N 次工具调用意味着 ≥ N+1 次 completion。
 */
export interface V2AgentConfig {
  /** 需要审批才能执行的工具名单。 */
  requireApproval?: Set<string>;
  /** 审批回调；返回 'deny' 会把"用户拒绝"当结果回喂给 reflector。 */
  approve?: (req: {
    toolName: string;
    args: Record<string, unknown>;
    stepId: string;
    sessionId: string;
  }) => Promise<'approve' | 'approve_session' | 'deny'>;
}

export class V2Agent {
  constructor(
    private readonly llm: LLMClient,
    private readonly registry: ToolRegistry,
    private readonly config: V2AgentConfig = {},
  ) {}

  async chat(session: Session, userInput: string, opts: V2Options = {}): Promise<V2Result> {
    const maxReflections = opts.maxReflections ?? 2;
    const maxVerifyRetries = opts.maxVerifyRetries ?? 2;

    session.history.push({ role: 'user', content: userInput });
    const start = Date.now();
    const metrics: V2Metrics = {
      llm_calls: 0, planner_calls: 0, reflector_calls: 0, synth_calls: 0,
      verify_attempts: 0, execute_attempts: 0, elapsed_ms: 0,
    };
    const allSpans: ExecSpan[] = [];
    const collectSpans = (s: ExecSpan) => { allSpans.push(s); opts.onSpan?.(s); };

    // 上下文压缩：若历史超阈值，折进一条 system 摘要。
    // 传 opts.context === null 显式关闭。
    if (opts.context !== null) {
      const cfg = opts.context ?? DEFAULT_CONTEXT_CONFIG;
      const useLLM = opts.useLLMCompression ?? true;
      const summarize = (msgs: Message[]) =>
        useLLM ? llmSummarize(this.llm, msgs) : heuristicSummarize(msgs);
      const r = await compressIfNeeded(session.history, cfg, summarize);
      if (r.compressed) session.history = r.history;
    }

    // 供 respond.synthesize=true 使用的综合器。
    // 契约：拿到极简指令 + 仅被引用的 outputs，返回最终文本。
    const synthesize = async (input: {
      guidance: string;
      outputs: Record<string, { ok: boolean; result?: unknown; error?: string }>;
      userInput?: string;
    }): Promise<string> => {
      metrics.synth_calls += 1;
      metrics.llm_calls += 1;
      const sys: Message = {
        role: 'system',
        content:
          `你是 LinAgent 的 Synthesizer（综合器）。所有工具都已被 runtime 执行完毕。` +
          `请基于 (a) 用户原始请求、(b) planner 的简短指令、(c) 工具的原始输出，` +
          `产出一个简洁的最终回答。` +
          `不要再提出新的工具调用。直接输出纯文本（不要 JSON，不要代码围栏）。`,
      };
      const usr: Message = {
        role: 'user',
        content:
          `用户请求：\n${input.userInput ?? ''}\n\n` +
          `Planner 指令：\n${input.guidance}\n\n` +
          `工具输出：\n${JSON.stringify(input.outputs, null, 2)}`,
      };
      const text = await this.llm.chat([sys, usr], { temperature: 0.2 });
      return text.trim();
    };

    // ── 1. 规划 + 校验（校验失败则让 planner 重来） ────────────────────
    let plan: Plan;
    let planRaw: string;
    let verifyIssues: string[] = [];
    let extraHistory: Message[] = [];

    for (let attempt = 0; attempt <= maxVerifyRetries; attempt++) {
      const p = await callPlanner(this.llm, this.registry, {
        history: [...session.history, ...extraHistory],
        onDelta: opts.onDelta ? (c) => opts.onDelta!(c, 'planner') : undefined,
      });
      plan = p.plan;
      planRaw = p.raw;
      metrics.planner_calls += 1;
      metrics.llm_calls += 1;
      metrics.verify_attempts += 1;
      try {
        verifyPlan(plan, this.registry);
        verifyIssues = [];
        break;
      } catch (err) {
        if (!(err instanceof PlanVerifyError)) throw err;
        verifyIssues = err.issues;
        if (attempt === maxVerifyRetries) {
          throw new PlannerError(`planner 连续 ${attempt + 1} 次未通过校验：${verifyIssues.join('; ')}`);
        }
        extraHistory = [
          { role: 'assistant', content: planRaw },
          {
            role: 'user',
            content: `你上一份 plan 校验未通过，问题如下：\n- ${verifyIssues.join('\n- ')}\n请按规则重新输出一份修正后的 Plan JSON。`,
          },
        ];
      }
    }

    // ── 2. 执行；失败则 reflect 并重试 ────────────────────────
    // 审批门：把工具审批适配成 executor 的 beforeTool 钩子。
    // 存 string[] 而不是 Set —— Set 无法 JSON 序列化，落盘后重启会变成 {} 崩溃。
    const beforeTool = async (info: { tool: string; args: Record<string, unknown>; stepId: string }): Promise<boolean> => {
      if (!this.config.requireApproval?.has(info.tool)) return true;
      const raw = session.state.__approvedTools;
      const approved: string[] = Array.isArray(raw) ? (raw as string[]) : [];
      if (approved.includes(info.tool)) return true;
      if (!this.config.approve) return false;
      const decision = await this.config.approve({
        toolName: info.tool, args: info.args, stepId: info.stepId, sessionId: session.id,
      });
      if (decision === 'deny') return false;
      if (decision === 'approve_session') {
        approved.push(info.tool);
        session.state.__approvedTools = approved;
      }
      return true;
    };

    let execResult;
    for (let reflection = 0; reflection <= maxReflections; reflection++) {
      metrics.execute_attempts += 1;
      execResult = await executePlan(plan!, this.registry, session, {
        onSpan: collectSpans,
        synthesize,
        userInput,
        beforeTool,
      });
      if (!execResult.failed_step) break;

      if (reflection === maxReflections) {
        // 重试次数用完 —— 温和地放弃。
        metrics.elapsed_ms = Date.now() - start;
        const fallback = `抱歉，我没能完成这个请求 (couldn't complete this request)。最后一次失败发生在步骤 "${execResult.failed_step}"：${execResult.failure_reason}`;
        session.history.push({ role: 'assistant', content: fallback });
        return { answer: fallback, plan: plan!, spans: allSpans, metrics };
      }

      const r = await callReflector(this.llm, this.registry, {
        history: session.history,
        previousPlan: plan!,
        execResult,
        onDelta: opts.onDelta ? (c) => opts.onDelta!(c, 'reflector') : undefined,
      });
      metrics.reflector_calls += 1;
      metrics.llm_calls += 1;

      plan = applyPatch(plan!, r.patch);
      // 再次校验 patch 后的 plan（校验失败就静默兜底 —— reflector 不能无限循环）。
      try { verifyPlan(plan, this.registry); }
      catch (err) {
        if (!(err instanceof PlanVerifyError)) throw err;
        metrics.elapsed_ms = Date.now() - start;
        const fallback = `Reflector 产出的 patch 不合法：${err.issues.join('; ')}`;
        session.history.push({ role: 'assistant', content: fallback });
        return { answer: fallback, plan, spans: allSpans, metrics };
      }
    }

    // ── 3. 从 respond 步骤取出最终答复 ───────────────────────
    metrics.elapsed_ms = Date.now() - start;
    const answer = execResult!.answer ?? '(没有产出答复)';
    session.history.push({ role: 'assistant', content: answer });
    return { answer, plan: plan!, spans: allSpans, metrics };
  }
}
