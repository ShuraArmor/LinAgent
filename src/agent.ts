import type { LLMClient, Message, MemoryHandle, SkillHandle, LedgerHandle, TraceEntry } from './types.ts';
import type { Session } from './session.ts';
import type { ToolRegistry } from './tools/registry.ts';
import type { SkillRegistry } from './skills.ts';
import { loadSkillTool, listSkillsTool, createSkillTool } from './tools/skill.ts';
import { ToolNotFoundError, ToolValidationError, ToolExecutionError } from './tools/registry.ts';
import { buildSystemPrompt } from './llm/prompt.ts';
import {
  compressIfNeeded,
  DEFAULT_CONTEXT_CONFIG,
  heuristicSummarize,
  llmSummarize,
  type ContextConfig,
} from './context.ts';
import type { MemoryStore, UserMemory } from './memory.ts';
import {
  addManual, forget, retrieveForQuery, formatForPrompt, recomputeTiers,
} from './memory.ts';
import type {
  LedgerStore, LedgerPatch, ArchiveStore, CompressionTriggerConfig, Preset,
} from './ledger/index.ts';
import {
  applyPatches,
  buildLedgerInstruction,
  renderLedgerForPrompt,
  renderPresetFewShot,
  tryCompress,
  compressTraceData,
  buildTriggerConfig,
  consolidateLedgerToMemory,
  consolidateStable,
  BACKSTOP_MIN_VALUE,
  pickPreset,
  updateLedgerTool,
} from './ledger/index.ts';
import type { Ledger } from './ledger/index.ts';
import type { FeedbackController } from './ledger/index.ts';
import type { BackgroundTaskManager } from './tasks/manager.ts';
import { taskTools } from './tools/tasks.ts';
// plan 模式：复用 plan 引擎纯函数（planner / verifier / executor / reflector）作为
// 同一个 ReAct agent 的一个决策模式。这些函数只吃 llm/registry/session，天然可嵌入。
import { plan as callPlanner, reflect as callReflector, applyPatch, PlannerError } from './plan/planner.ts';
import { verifyPlan, PlanVerifyError } from './plan/verifier.ts';
import { executePlan } from './plan/executor.ts';
import type { Plan } from './plan/plan.ts';
import type { ExecSpan } from './plan/executor.ts';

/** 工具审批的返回值。 */
export type ApprovalDecision = 'approve' | 'approve_session' | 'deny';

/**
 * 手动压缩（compressNow）的结果 —— 在通用压缩报告基础上，额外带上账本条目数。
 * ledgerItems===0 表示这轮没维护账本：压缩只归档了原文，上下文里没有结构化摘要留存。
 */
export type ManualCompressResult = import('./ledger/index.ts').CompressTraceData & {
  ledgerItems: number;
};

/** plan 模式的指标（与 loop 模式的 turns 并列，只在 plan 模式填充）。 */
export interface PlanMetrics {
  planner_calls: number;
  reflector_calls: number;
  verify_attempts: number;
  execute_attempts: number;
  elapsed_ms: number;
}

export interface ApprovalRequest {
  toolName: string;
  args: Record<string, unknown>;
  turn: number;
  sessionId: string;
}

export interface AgentConfig {
  maxTurns: number;
  context: ContextConfig;
  /** true 时用 LLM 做上下文摘要压缩；false 时降级为启发式版本。默认 true。 */
  useLLMCompression: boolean;
  /** 每产生一条 trace 都会回调一次。 */
  onTrace?: (entry: TraceEntry) => void;
  /**
   * 需要用户审批才能调用的工具名单。工具在这里出现 → 每次调用前都会走 `approve`。
   * 与 tools/index.ts 里的 RISKY_TOOLS 互相独立，调用方自行组合。
   */
  requireApproval?: Set<string>;
  /**
   * 审批回调；返回 'deny' 会把"用户拒绝"作为工具结果回喂给 LLM。
   * 未设置时，`requireApproval` 里的工具会被默认拒绝（fail-closed）。
   */
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** MCP 资源描述段，拼进 system prompt。由 MCPManager.describeResources() 生成。 */
  mcpResources?: string;
  /** plan 模式：reflector 修补失败 plan 的最大次数。默认 2。 */
  planReflections?: number;
  /** plan 模式：planner 输出未通过校验时的最大重试次数。默认 2。 */
  planVerifyRetries?: number;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 32),
  context: {
    maxMessages: Number(process.env.AGENT_CONTEXT_MAX_MESSAGES ?? DEFAULT_CONTEXT_CONFIG.maxMessages),
    keepRecent: DEFAULT_CONTEXT_CONFIG.keepRecent,
  },
  useLLMCompression: true,
};

/** chat / resumeForTasks 的回调集（per-call，比 config.onTrace 优先级高）。 */
export interface ChatHooks {
  onDelta?: (chunk: string, turn: number) => void;
  onReasoningDelta?: (chunk: string, turn: number) => void;
  onTurnStart?: (turn: number) => void;
  onTrace?: (entry: TraceEntry) => void;
  /** plan 模式：每个执行 span 开始/结束时回调（REPL 用来画 span 流）。 */
  onSpan?: (span: ExecSpan) => void;
  /** plan 模式：planner/reflector 的流式增量。 */
  onPlanDelta?: (chunk: string, phase: 'planner' | 'reflector') => void;
  /**
   * 用户打断信号。aborted 时：在途 LLM 请求立即断流，agent 循环在下一个检查点收尾退出，
   * 已流式产出的部分正常保留。由 REPL 的 Esc 键触发。
   */
  signal?: AbortSignal;
}

export interface RunResult {
  finalAnswer: string;
  turns: number;
  trace: TraceEntry[];
  /**
   * 本轮发给 LLM 的 system prompt 组成（每轮临时拼，不写进 session.history —
   * REPL 拿来正确算 token 用量）。
   */
  systemPromptBase: string;   // 工具描述 + 角色约束
  memoryPrompt: string;        // 跨会话记忆注入段（空串代表没注入）
  /** 账本相关段：指令 + 当前账本渲染（若启用了账本）。 */
  ledgerPrompt?: string;
  /** plan 模式产出：本轮的 Plan（loop 模式为 undefined）。 */
  plan?: Plan;
  /** plan 模式产出：执行 span 流（loop 模式为 undefined）。 */
  spans?: ExecSpan[];
  /** plan 模式产出：规划/执行指标（loop 模式为 undefined）。 */
  planMetrics?: PlanMetrics;
}

export interface MemoryConfig {
  store: MemoryStore;
  userId: string;
  /**
   * 是否跳过会话闭合时的账本→记忆自动巩固（consolidate）。默认 false。
   * memory 工具（用户显式 add/forget）和 recall_memory（召回）不受它影响。
   */
  disableIngest?: boolean;
  /**
   * 沉淀模式（M1）：
   *   'incremental'（默认）—— 每轮末沉稳定的高价值原语 + 会话收尾兜底扫。
   *                          漏标 wrapping 也不丢高价值信息。
   *   'wrap'              —— 仅会话收尾（wrapping/closed）时一次性沉淀（M0 旧行为）。
   */
  consolidate?: 'incremental' | 'wrap';
  /**
   * 分层模式（M2）：
   *   'dynamic'（默认）—— freeze 时按召回反馈升降级 tier（warm↔frozen↔dormant）+ frozen 容量控制。
   *                      年轻/无召回历史的记忆下是 no-op，安全。
   *   'static'        —— tier 恒为 layer 派生初值，不升降级（M1 及之前的行为）。
   */
  tiering?: 'dynamic' | 'static';
}

/**
 * 会话账本配置。见 src/ledger/ 子系统。
 * 提供 store 就启用账本；每轮 chat 会加载账本、注入 prompt、应用 LLM 提交的 patch。
 */
export interface LedgerConfig {
  store: LedgerStore;
  /**
   * 会话账本用哪种语言解释指令段（"zh" / "en"）。当前只 "zh" 有 prompt 实现，
   * 传别的默认按 "zh" 处理。
   */
  language?: string;
  /**
   * 归档 store —— 用于账本驱动的压缩。传了就启用新压缩机制（旧的 context.ts
   * 走的 FIFO 摘要不再触发）；不传时压缩仍走旧路径。
   */
  archive?: ArchiveStore;
  /** 压缩触发条件；不传时用 buildTriggerConfig() 生成默认。 */
  trigger?: Partial<CompressionTriggerConfig>;
  /**
   * 可选：候选 preset 集合。不传就用 BUILTIN_PRESETS（4 份内置）。
   * 用户想加自己的 preset 就在 REPL 那层 mergePresets(userPresets) 传进来。
   */
  presets?: Preset[];
  /**
   * 反馈控制器（Phase 2）——压缩与记忆共享的负反馈环。传了则：
   *   · 压缩/沉淀的 valueOf 读入它的 bias（越被召回的 kind 越易保留/沉淀）
   *   · 类别从结构涌现时，bias 影响哪个 kind 主导形状
   * recall 工具那侧的 record 在 runtime 装配时挂到同一个 controller 上。
   */
  feedback?: FeedbackController;
}

function makeMemoryHandle(store: MemoryStore, userId: string, sessionId: string): MemoryHandle {
  return {
    list: () => {
      const mem = store.load(userId);
      return mem.facts.filter((f) => !f.superseded_by).map((f) => ({
        id: f.id, layer: f.layer, text: f.text, confidence: f.confidence, tags: f.tags,
      }));
    },
    add: (layer, text) => {
      const mem = store.load(userId);
      const f = addManual(mem, layer, text, { session: sessionId, turn: -1 }, Date.now());
      store.save(mem);
      return { id: f.id, layer: f.layer, text: f.text };
    },
    forget: (id) => {
      const mem = store.load(userId);
      const f = forget(mem, id);
      if (!f) return { ok: false, error: `no fact ${id}` };
      store.save(mem);
      return { ok: true, forgotten: f.id };
    },
  };
}

export class Agent {
  /**
   * "本会话都允许"的放行名单 —— **进程内存**，按 sessionId 存，不落盘。
   * 安全考量：放行只在本次进程运行期间有效；重启后重新询问，避免用户几天前
   * 点过"允许"、下次打开这个会话危险工具就被静默执行。
   */
  private sessionApprovals = new Map<string, Set<string>>();

  /**
   * 会话级冻结的 system prompt —— 进程内存，按 "sessionId|planMode" 存。
   * 首轮构建一次（基座 + identity/preferences 快照 + 账本指令 + preset few-shot），之后整会话复用。
   * 这是保住 provider 前缀缓存的核心：system 消息一字不变，缓存前缀才不作废。
   * 用 planMode 入 key —— 切 plan/loop 会换基座描述，自然重新冻结；/new 换 sessionId 也自然失效。
   */
  private frozenSystemPrompt = new Map<string, string>();

  /** 让某会话下次 chat 重新冻结 system prompt（/reset 后调 —— 记忆/账本可能已变）。 */
  invalidateFrozenPrompt(sessionId: string): void {
    for (const key of [...this.frozenSystemPrompt.keys()]) {
      if (key.startsWith(`${sessionId}|`)) this.frozenSystemPrompt.delete(key);
    }
  }

  private approvedSet(sessionId: string): Set<string> {
    let s = this.sessionApprovals.get(sessionId);
    if (!s) { s = new Set(); this.sessionApprovals.set(sessionId, s); }
    return s;
  }

  constructor(
    private readonly llm: LLMClient,
    private readonly registry: ToolRegistry,
    private readonly config: AgentConfig = DEFAULT_AGENT_CONFIG,
    private readonly memory?: MemoryConfig,
    private readonly skills?: SkillRegistry,
    private readonly ledger?: LedgerConfig,
    private readonly taskManager?: BackgroundTaskManager,
  ) {
    // 配了 skill 注册表 → 注册 skill 相关工具（幂等：已注册就跳过）。
    // create_skill 和 list_skills 即使当前没有 skill 也要注册（agent 需要能创建第一个）。
    // load_skill 只在有 skill 时才有意义。
    if (this.skills) {
      if (!this.registry.has('list_skills')) this.registry.register(listSkillsTool);
      if (!this.registry.has('create_skill')) this.registry.register(createSkillTool);
      if (this.skills.list().length > 0 && !this.registry.has('load_skill')) {
        this.registry.register(loadSkillTool);
      }
    }
    // 启用账本 → 注册 update_ledger 工具（agent 通过它维护账本）。
    if (this.ledger && !this.registry.has('update_ledger')) {
      this.registry.register(updateLedgerTool);
    }
    // 启用后台任务 → 注册任务工具集（spawn_task / check_task / list_tasks / cancel_task）。
    if (this.taskManager) {
      for (const t of taskTools) if (!this.registry.has(t.name)) this.registry.register(t);
    }
  }

  /** 给工具用的后台任务 handle —— 转发到 BackgroundTaskManager，绑定当前 session。 */
  private taskHandle(sessionId: string): import('./types.ts').TaskHandle | undefined {
    if (!this.taskManager) return undefined;
    const mgr = this.taskManager;
    return {
      spawn: (tool, args, label, graceMs) => mgr.spawn(sessionId, tool, args, label, graceMs),
      check: (id) => mgr.check(id),
      list: (status) => mgr.list(sessionId, status),
      cancel: (id) => mgr.cancel(id),
    };
  }

  private skillHandle(): SkillHandle | undefined {
    if (!this.skills) return undefined;
    const skills = this.skills;
    return {
      load: (name) => {
        const s = skills.load(name);
        return { name: s.name, description: s.description, body: s.body, script: s.script };
      },
      names: () => skills.list().map((s) => s.name),
      list: () => skills.list().map((s) => ({ name: s.name, description: s.description })),
      create: (name, description, body, opts) => skills.create(name, description, body, opts),
    };
  }

  /**
   * 给 update_ledger 工具用的 handle —— 把 patch 应用到当前会话账本上。
   * currentLedger 在 chat 里 load 一次、循环内共享；这里闭包捕获它。
   */
  private makeLedgerHandle(
    ledger: Ledger,
    turn: number,
    push: (kind: TraceEntry['kind'], data: unknown, t: number) => void,
  ): LedgerHandle {
    return {
      applyPatches: (patches) => {
        const valid = (patches as LedgerPatch[]).filter((p) => !!p && typeof p === 'object');
        const report = applyPatches(ledger, valid, turn);
        ledger.turn_count = turn;
        ledger.updated_at = Date.now();
        push('ledger', {
          phase: 'patched',
          applied: report.applied.length,
          failed: report.failed.length,
          failures: report.failed.map((f) => f.error),
        }, turn);
        return report;
      },
    };
  }

  /**
   * 正常对话轮：用户发一条消息，跑一轮决策。
   */
  async chat(session: Session, userInput: string, hooks?: ChatHooks): Promise<RunResult> {
    return this.runTurn(session, userInput, hooks);
  }

  /**
   * 唤醒轮：**不带用户消息**，只把已完成的后台任务结果注入历史后跑一轮。
   * 由 REPL 在"某个后台任务/workflow 完成"时主动调用——让 agent 自己醒过来处理结果，
   * 不用干等用户下次发言、也不用轮询。agent 自主决定要不要回复用户（见注入措辞）。
   * 若此刻没有未投递的完成任务（drain 为空），直接返回一个 no-op 结果，不打扰 LLM。
   */
  async resumeForTasks(session: Session, hooks?: ChatHooks): Promise<RunResult> {
    return this.runTurn(session, null, hooks);
  }

  /**
   * 一轮的共用实现。userInput===null 表示唤醒轮（无用户消息）。
   */
  private async runTurn(
    session: Session,
    userInput: string | null,
    hooks?: ChatHooks,
  ): Promise<RunResult> {
    const startTrace = session.trace.length;
    const push = (kind: TraceEntry['kind'], data: unknown, turn: number) => {
      const entry: TraceEntry = { turn, timestamp: Date.now(), kind, data };
      session.trace.push(entry);
      hooks?.onTrace?.(entry);       // per-call handler 优先
      this.config.onTrace?.(entry);  // config-level handler 兜底
    };

    // 后台任务完成通知：把已完成（未投递）的后台任务结果，作为 system 消息注入本轮。
    // drainCompleted 内部标记 delivered，不重复注入。措辞里给 agent 明确的行动指令，
    // 落实"agent 自己判断"——需要则继续后续步骤/告知用户，否则静默处理。
    let injectedCount = 0;
    if (this.taskManager) {
      const done = this.taskManager.drainCompleted(session.id);
      for (const t of done) {
        const body = t.status === 'done'
          ? `结果：${truncateForInject(JSON.stringify(t.result))}`
          : `失败：${t.error}`;
        session.history.push({
          role: 'system',
          content:
            `[后台任务 ${t.id}「${t.label}」已${t.status === 'done' ? '完成' : '失败'}] ${body}\n` +
            `（这是你之前发起的后台任务的结果。请判断：需要据此继续后续步骤、或告知用户，就做；` +
            `若无需用户关注，可静默处理、简短收尾。完整结果可用 check_task("${t.id}") 再取。）`,
        });
        push('tool_result', { backgroundTask: t.id, status: t.status }, 0);
        injectedCount += 1;
      }
    }

    // 唤醒轮（userInput===null）且没有任何新完成任务可注入 → no-op，不打扰 LLM。
    if (userInput === null && injectedCount === 0) {
      return {
        finalAnswer: '', turns: 0, trace: session.trace.slice(startTrace),
        systemPromptBase: '', memoryPrompt: '',
      };
    }

    // 正常轮才 push 用户消息；唤醒轮没有用户输入。
    if (userInput !== null) {
      session.history.push({ role: 'user', content: userInput });
      push('user_input', { text: userInput }, 0);
    }

    // ── 冻结的 system prompt（保 provider 前缀缓存）─────────────────────
    // 首轮构建一次，整会话复用。冻结内容：基座 + identity/preferences 快照 +
    // 账本指令段 + preset few-shot。这些在会话内视为不变。
    // 每轮变化的东西（账本"当前内容"、按话题命中的 facts）都不在这里 —— 见下。
    // 放在压缩之前算：freeze 只读 memory/preset，与 history 无关，不受压缩影响；先算出来
    // 好让下面的压缩触发判断能把 system 段的 token 算进去（否则会严重低估、偏晚触发）。
    const userMem: UserMemory | undefined = this.memory
      ? this.memory.store.load(this.memory.userId) : undefined;
    const systemPrompt = this.freezeSystemPrompt(session, userMem, userInput, push);
    // systemPromptBase 供 token 统计/测试用 —— 现在就是冻结后的整段。
    const systemPromptBase = systemPrompt;
    // memoryPrompt 字段保留（供 RunResult / token 统计）：现在填冻结快照里的记忆段。
    const memoryPrompt = userMem
      ? formatForPrompt(retrieveForQuery(userMem, '', 0)) : '';

    // 会话账本：加载 + 渲染当前内容（不进 system，每轮作为 messages 末尾动态 system 消息注入，
    // 见 buildMessages）。history 尾部变化不碰缓存前缀。
    let currentLedger = this.ledger?.store.load(session.id, this.ledger.language ?? 'zh');
    let ledgerPrompt = '';
    if (this.ledger && currentLedger) {
      ledgerPrompt = renderLedgerForPrompt(currentLedger);
      push('ledger', { phase: 'loaded', items: totalItems(currentLedger) }, 0);
    }

    // 压缩：让上下文跨会话保持在可控大小。现在 system(冻结) + 账本内容都已算出，
    // 触发判断按"完整 system 段 + history"估算，不再低估。
    await this.maybeCompress(session, 0, push, [systemPrompt, ledgerPrompt].filter(Boolean).join('\n\n'), currentLedger);

    // 每轮把账本当前内容拼在 messages 末尾（history 之后），不进 session.history 持久化。
    const buildMessages = (): Message[] => {
      const msgs: Message[] = [{ role: 'system', content: systemPrompt }, ...session.history];
      if (ledgerPrompt) msgs.push({ role: 'system', content: ledgerPrompt });
      return msgs;
    };

    let finalAnswer: string | null = null;
    let turn = 0;
    // plan 模式产出（loop 模式保持 undefined，收尾时原样带进 RunResult）。
    let planOut: { plan: Plan; spans: ExecSpan[]; metrics: PlanMetrics } | undefined;

    // ── 决策模式分叉 ────────────────────────────────────────────────
    // planMode 开启 → 先规划再执行（planner→verifier→executor→reflector）；
    // 关闭 → 原 ReAct while 循环（边想边做）。两条路径共用下面的收尾
    // （账本落盘 + 记忆写入），因为收尾在循环之后、对两者都跑。
    if (session.state.planMode) {
      // 唤醒轮无用户输入 —— 给 planner 一个合成目标（历史里已注入任务结果供它规划）。
      const planInput = userInput ?? '（后台任务已完成，见上方结果；据此规划下一步，或直接收尾。）';
      const r = await this.runPlanMode(session, planInput, systemPrompt, ledgerPrompt, push, hooks);
      finalAnswer = r.answer;
      planOut = { plan: r.plan, spans: r.spans, metrics: r.metrics };
      turn = 1; // 概念上 plan 模式是"一轮"（一次规划 + 一次执行编排）
    } else
    while (turn < this.config.maxTurns) {
      turn += 1;
      hooks?.onTurnStart?.(turn);

      // system（冻结，缓存前缀）+ history + 账本当前内容（末尾动态 system）。
      const messages = buildMessages();

      let assistantTurn;
      try {
        assistantTurn = await this.llm.chat({
          messages,
          tools: this.registry.toSpecs(),
          toolChoice: 'auto',
          onDelta: hooks?.onDelta ? (chunk) => hooks.onDelta!(chunk, turn) : undefined,
          onReasoningDelta: hooks?.onReasoningDelta ? (chunk) => hooks.onReasoningDelta!(chunk, turn) : undefined,
          signal: hooks?.signal,
        });
      } catch (err) {
        // 用户主动打断（Esc）：不是错误，正常收尾。断流时已流式产出的文本仍保留在 UI，
        // 但这轮没拿到完整 assistantTurn，不塞进 history（避免半截 assistant 破坏多轮回传）。
        if (hooks?.signal?.aborted) {
          push('final', { answer: '', interrupted: true }, turn);
          finalAnswer = '（已打断 / interrupted）';
          break;
        }
        let msg = err instanceof Error ? err.message : String(err);
        // 空闲超时：fetch 被 abort(reason) 掐断，裸错误是 "This operation was aborted"（无信息量）。
        // 把 signal.reason 里带的 LLMTimeoutError 信息翻出来，让用户看到真实原因。
        const isAbort = err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
        if (isAbort) {
          const reason = (err as { cause?: unknown }).cause;
          msg = reason instanceof Error ? reason.message
            : 'LLM 响应超时被中断（空闲超时）。若回复本应很长，可调大环境变量 LLM_TIMEOUT_MS。';
        }
        // LLMHttpError 带 provider 返回的 body —— 400 的真正原因在这里，一定要带出来。
        const body = (err as { body?: string }).body;
        if (body) msg += ` — ${body}`;
        push('error', { where: 'llm', message: msg }, turn);
        session.history.push({
          role: 'assistant',
          content: `[agent error: LLM call failed — ${msg}]`,
        });
        finalAnswer = `抱歉，语言模型调用失败 (language model call failed): ${msg}`;
        break;
      }

      push('llm_response', { text: assistantTurn.text, toolCalls: assistantTurn.toolCalls.length }, turn);

      // 把 assistant 回合原样塞进历史 —— 带上 toolCalls / thinking / providerRaw，
      // 保证多轮回传时 provider 能拿到完整的 tool_use / thinking block 结构。
      session.history.push({
        role: 'assistant',
        content: assistantTurn.text,
        toolCalls: assistantTurn.toolCalls.length ? assistantTurn.toolCalls : undefined,
        thinking: assistantTurn.thinking,
        providerRaw: assistantTurn.raw,
      });

      // 没有工具调用 = 模型选择直接回答，本轮就是最终答复。
      if (assistantTurn.toolCalls.length === 0) {
        push('final', { answer: assistantTurn.text }, turn);
        finalAnswer = assistantTurn.text;
        break;
      }

      // 有工具调用（可能并行多个）—— 逐个走审批门 + 执行，结果作为 role:"tool" 消息回传。
      for (const call of assistantTurn.toolCalls) {
        // 审批门：工具在 requireApproval 里且未获本次进程内的会话放行 → 弹审批。
        // 放行名单走进程内存（sessionApprovals），不落盘 —— 重启后重新询问。
        let approvalDenied: string | null = null;
        if (this.config.requireApproval?.has(call.name)) {
          const approved = this.approvedSet(session.id);
          if (!approved.has(call.name)) {
            if (!this.config.approve) {
              approvalDenied = '当前 agent 未配置审批器，且该工具需要审批 → fail-closed 拒绝';
            } else {
              // approve() 抛错时按 deny 处理 —— 绝不能让异常冒出循环，否则这条 assistant
              // 已带 tool_calls 进了 history，却没有对应 tool 结果，下一轮回传就 400。
              let decisionA: ApprovalDecision;
              try {
                decisionA = await this.config.approve({
                  toolName: call.name, args: call.args, turn, sessionId: session.id,
                });
              } catch (err) {
                decisionA = 'deny';
                push('error', { where: 'approval', name: call.name, message: (err as Error).message }, turn);
              }
              push('memory', { phase: 'approval', tool: call.name, decision: decisionA }, turn);
              if (decisionA === 'deny') {
                approvalDenied = '用户拒绝了本次工具调用';
              } else if (decisionA === 'approve_session') {
                approved.add(call.name);
              }
            }
          }
        }

        push('tool_call', { name: call.name, args: call.args }, turn);

        let toolContent: string;
        if (call.parseError) {
          // 参数 JSON 没解析成功（多半被 max_tokens 截断）——别拿空 args 跑校验误报"缺参数"，
          // 直接把真实原因回喂给模型让它重发这次调用。
          toolContent = JSON.stringify({ ok: false, error: { kind: 'args_parse', message: call.parseError } });
          push('error', { where: 'tool', name: call.name, kind: 'args_parse', message: call.parseError }, turn);
        } else if (approvalDenied) {
          toolContent = JSON.stringify({ ok: false, error: { kind: 'denied', message: approvalDenied } });
          push('error', { where: 'tool', name: call.name, kind: 'denied', message: approvalDenied }, turn);
        } else {
          try {
            const result = await this.registry.invoke(call.name, call.args, {
              sessionId: session.id,
              sessionState: session.state,
              logger: (m) => push('tool_call', { log: m, name: call.name }, turn),
              memory: this.memory
                ? makeMemoryHandle(this.memory.store, this.memory.userId, session.id)
                : undefined,
              skills: this.skillHandle(),
              ledger: currentLedger ? this.makeLedgerHandle(currentLedger, turn, push) : undefined,
              tasks: this.taskHandle(session.id),
            });
            toolContent = JSON.stringify({ ok: true, result });
            push('tool_result', { name: call.name, result }, turn);
          } catch (err) {
            const kind =
              err instanceof ToolNotFoundError ? 'not_found'
              : err instanceof ToolValidationError ? 'validation'
              : err instanceof ToolExecutionError ? 'execution'
              : 'unknown';
            const message = err instanceof Error ? err.message : String(err);
            toolContent = JSON.stringify({ ok: false, error: { kind, message } });
            push('error', { where: 'tool', name: call.name, kind, message }, turn);
          }
        }

        // 每个 tool call 回一条 role:"tool" 消息，用 toolCallId 对应（原生协议要求）。
        session.history.push({
          role: 'tool',
          toolName: call.name,
          toolCallId: call.id,
          content: toolContent,
        });
      }

      // 用户打断：工具已跑完（这批 tool 结果已进 history，多轮回传结构完整），到此正常收尾，
      // 不再进下一轮 LLM 调用。放在这里而非循环顶 —— 保证不留悬空 tool_call。
      if (hooks?.signal?.aborted) {
        push('final', { answer: '', interrupted: true }, turn);
        finalAnswer = '（已打断 / interrupted）';
        break;
      }

      // 触发条件按"完整 system prompt token + history token"估算。
      await this.maybeCompress(session, turn, push, systemPrompt, currentLedger);
    }

    if (finalAnswer === null) {
      finalAnswer = `已达 max turns (${this.config.maxTurns}) 上限，仍未产出最终答复。`;
      push('error', { where: 'loop', message: finalAnswer }, turn);
      session.history.push({ role: 'assistant', content: `[agent] ${finalAnswer}` });
    }

    // 记忆写入 —— 账本沉淀为唯一自动写入路径（extractor 每轮抽取已废弃删除）。
    //   M1 双路径（默认 incremental）：
    //     · 增量：每轮末沉"稳定的高价值"原语（value≥hi 且存活≥N 轮），沉过打标记跳过。
    //             漏标 wrapping 也不丢高价值信息 —— 治了"全有或全无"的老病。
    //     · 兜底：会话收尾（wrapping/closed）时全扫 value≥lo，收走增量没够格的残余。
    //   'wrap' 模式退化为 M0 旧行为（仅收尾一次性沉淀）。
    //   另一条写入路径是用户显式的 memory 工具（add/forget），不在这里。
    //   注意：增量会给账本条目打 meta.consolidated 标记，必须在账本落盘【之前】跑，标记才随盘持久。
    const ledgerWraps = currentLedger?.core.state === 'wrapping'
                     || currentLedger?.core.state === 'closed';
    if (this.memory && !this.memory.disableIngest && userMem
        && this.ledger && currentLedger) {
      const mode = this.memory.consolidate ?? 'incremental';
      const fbBias = this.ledger.feedback?.bias();  // Phase 2：反馈偏置进估值门
      try {
        let report;
        if (mode === 'wrap') {
          // 旧行为：仅收尾一次性沉淀（无估值门）。
          if (ledgerWraps) report = consolidateLedgerToMemory(currentLedger, userMem, Date.now());
        } else if (ledgerWraps) {
          // 兜底扫：收尾时用 lo 阈值收走残余（会顺带处理增量已标记的——Jaccard 去重不重复入库）。
          report = consolidateLedgerToMemory(currentLedger, userMem, Date.now(), {
            minValue: BACKSTOP_MIN_VALUE, currentTurn: turn, bias: fbBias,
          });
        } else {
          // 增量：每轮末沉稳定的高价值原语。
          report = consolidateStable(currentLedger, userMem, turn, Date.now(), fbBias);
        }
        // 仅当真有新增/更新才落盘，省 IO（增量稳态下多数轮是 0 变化）。
        if (report && (report.merge.added.length || report.merge.updated.length || report.merge.superseded.length)) {
          this.memory.store.save(userMem);
          push('memory', {
            phase: mode === 'wrap' || ledgerWraps ? 'consolidate' : 'consolidate_incremental',
            candidates: report.candidates,
            added: report.merge.added.length,
            updated: report.merge.updated.length,
            superseded: report.merge.superseded.length,
          }, turn);
        }
      } catch (err) {
        push('error', { where: 'memory_consolidate', message: (err as Error).message }, turn);
      }
    }

    // 账本落盘。chat 结束时统一保存，不每轮 patch 都写盘（IO 摊薄）。
    // 放在记忆沉淀【之后】：增量沉淀会给条目打 meta.consolidated，要随这次落盘持久。
    if (this.ledger && currentLedger) {
      try {
        this.ledger.store.save(currentLedger);
      } catch (err) {
        push('error', { where: 'ledger_save', message: (err as Error).message }, turn);
      }
    }

    return {
      finalAnswer,
      turns: turn,
      trace: session.trace.slice(startTrace),
      systemPromptBase,
      memoryPrompt,
      ledgerPrompt: ledgerPrompt || undefined,
      plan: planOut?.plan,
      spans: planOut?.spans,
      planMetrics: planOut?.metrics,
    };
  }

  /**
   * plan 模式的编排：planner → verifier →（重试）→ executor →（reflect 重试）。
   * 复用 plan/ 下的纯函数，但跑在同一个 Agent / session 上，因此天然拥有记忆、账本、
   * 技能、后台任务 —— 这些是 plan 模式作为「同一个 agent 的一个决策模式」白拿的。
   *
   * 记忆/账本注入：planner 有自己的 system prompt（角色 + 工具清单），这里把
   * memory/ledger 段作为**前置 system 消息**塞进 planner 看到的 history，让它带着
   * 跨会话记忆和会话账本去规划，而不与 planner 的角色 prompt 冲突。
   */
  private async runPlanMode(
    session: Session,
    userInput: string,
    frozenSystem: string,
    ledgerPrompt: string,
    push: (kind: TraceEntry['kind'], data: unknown, turn: number) => void,
    hooks?: {
      onSpan?: (span: ExecSpan) => void;
      onPlanDelta?: (chunk: string, phase: 'planner' | 'reflector') => void;
    },
  ): Promise<{ answer: string; plan: Plan; spans: ExecSpan[]; metrics: PlanMetrics }> {
    const maxReflections = this.config.planReflections ?? 2;
    const maxVerifyRetries = this.config.planVerifyRetries ?? 2;
    const start = Date.now();
    const metrics: PlanMetrics = {
      planner_calls: 0, reflector_calls: 0, verify_attempts: 0, execute_attempts: 0, elapsed_ms: 0,
    };
    const allSpans: ExecSpan[] = [];
    const collectSpans = (s: ExecSpan) => { allSpans.push(s); hooks?.onSpan?.(s); };

    // 记忆/账本作为前置 system 消息注入 planner 上下文（非空才注入）。
    // planner 有自己的角色 system prompt（plannerSystemPrompt），所以这里不注入 loop 基座，
    // 只把跨会话记忆快照（identity/preferences）+ 账本当前内容作为上下文喂给它。
    // frozenSystem 参数在 plan 模式下不直接用（planner 自带 system），保留签名对齐 loop 侧语义。
    void frozenSystem;
    const memSnapshot = this.memory
      ? formatForPrompt(retrieveForQuery(this.memory.store.load(this.memory.userId), '', 0)) : '';
    const contextSeg = [memSnapshot, ledgerPrompt].filter((s) => s && s.length).join('\n\n');
    const planContextHistory: Message[] = contextSeg
      ? [{ role: 'system', content: contextSeg }, ...session.history]
      : [...session.history];

    // 审批门：复用进程内存的会话放行名单，适配成 executor 的 beforeTool 钩子。
    const beforeTool = async (info: { tool: string; args: Record<string, unknown>; stepId: string }): Promise<boolean> => {
      if (!this.config.requireApproval?.has(info.tool)) return true;
      const approved = this.approvedSet(session.id);
      if (approved.has(info.tool)) return true;
      if (!this.config.approve) return false;
      const decision = await this.config.approve({
        toolName: info.tool, args: info.args, turn: 1, sessionId: session.id,
      });
      if (decision === 'deny') return false;
      if (decision === 'approve_session') approved.add(info.tool);
      return true;
    };

    // synthesize：供 respond 步骤 synthesize=true 时产出最终文本。
    const synthesize = async (input: {
      guidance: string;
      outputs: Record<string, { ok: boolean; result?: unknown; error?: string }>;
      userInput?: string;
    }): Promise<string> => {
      const sys: Message = {
        role: 'system',
        content:
          `你是 LinAgent 的 Synthesizer（综合器）。所有工具都已被 runtime 执行完毕。` +
          `请基于 (a) 用户原始请求、(b) planner 的简短指令、(c) 工具的原始输出，产出简洁的最终回答。` +
          `不要再提出新的工具调用。直接输出纯文本。`,
      };
      const usr: Message = {
        role: 'user',
        content:
          `用户请求：\n${input.userInput ?? ''}\n\n` +
          `Planner 指令：\n${input.guidance}\n\n工具输出：\n${JSON.stringify(input.outputs, null, 2)}`,
      };
      return (await this.llm.complete([sys, usr], { temperature: 0.2 })).trim();
    };

    // ── 1. 规划 + 校验（校验失败让 planner 重来） ─────────────────────
    let plan: Plan;
    let planRaw = '';
    let extraHistory: Message[] = [];
    for (let attempt = 0; attempt <= maxVerifyRetries; attempt++) {
      // planner 调用本身可能失败（输出被截断 / 返回空 → PlannerError）。这类失败也算一次
      // 尝试：只要还有重试额度就重来，而不是让异常冒出整轮把 plan 模式打死。
      let p;
      try {
        p = await callPlanner(this.llm, this.registry, {
          history: [...planContextHistory, ...extraHistory],
          onDelta: hooks?.onPlanDelta ? (ch) => hooks.onPlanDelta!(ch, 'planner') : undefined,
        });
      } catch (err) {
        if (!(err instanceof PlannerError)) throw err;
        metrics.planner_calls += 1;
        push('plan', { phase: 'planner_error', attempt, message: err.message }, 1);
        if (attempt === maxVerifyRetries) throw err;
        // 让下一次重试更短、更聚焦，降低再次被截断的概率。
        extraHistory = [
          { role: 'user', content: `上次没能拿到你的 Plan：${err.message}。请重新输出一份**完整**的 Plan JSON，尽量精简步骤，确保 JSON 完整闭合。` },
        ];
        continue;
      }
      plan = p.plan;
      planRaw = p.raw;
      metrics.planner_calls += 1;
      metrics.verify_attempts += 1;
      push('plan', { phase: 'planned', steps: plan.steps.length, attempt }, 1);
      try {
        verifyPlan(plan, this.registry);
        break;
      } catch (err) {
        if (!(err instanceof PlanVerifyError)) throw err;
        if (attempt === maxVerifyRetries) {
          throw new PlannerError(`planner 连续 ${attempt + 1} 次未通过校验：${err.issues.join('; ')}`);
        }
        extraHistory = [
          { role: 'assistant', content: planRaw },
          { role: 'user', content: `你上一份 plan 校验未通过：\n- ${err.issues.join('\n- ')}\n请重新输出修正后的 Plan JSON。` },
        ];
      }
    }

    // ── 2. 执行；失败则 reflect 重试 ─────────────────────────────────
    let execResult;
    for (let reflection = 0; reflection <= maxReflections; reflection++) {
      metrics.execute_attempts += 1;
      execResult = await executePlan(plan!, this.registry, session, {
        onSpan: collectSpans, synthesize, userInput, beforeTool,
      });
      if (!execResult.failed_step) break;

      if (reflection === maxReflections) {
        metrics.elapsed_ms = Date.now() - start;
        const fallback = `抱歉，我没能完成这个请求。最后一次失败在步骤 "${execResult.failed_step}"：${execResult.failure_reason}`;
        session.history.push({ role: 'assistant', content: fallback });
        return { answer: fallback, plan: plan!, spans: allSpans, metrics };
      }
      const r = await callReflector(this.llm, this.registry, {
        history: session.history, previousPlan: plan!, execResult,
        onDelta: hooks?.onPlanDelta ? (ch) => hooks.onPlanDelta!(ch, 'reflector') : undefined,
      });
      metrics.reflector_calls += 1;
      plan = applyPatch(plan!, r.patch);
      try { verifyPlan(plan, this.registry); }
      catch (err) {
        if (!(err instanceof PlanVerifyError)) throw err;
        metrics.elapsed_ms = Date.now() - start;
        const fallback = `Reflector 产出的 patch 不合法：${err.issues.join('; ')}`;
        session.history.push({ role: 'assistant', content: fallback });
        return { answer: fallback, plan, spans: allSpans, metrics };
      }
    }

    // ── 3. 取最终答复 ───────────────────────────────────────────────
    metrics.elapsed_ms = Date.now() - start;
    const answer = execResult!.answer ?? '(没有产出答复)';
    session.history.push({ role: 'assistant', content: answer });
    push('final', { answer }, 1);
    return { answer, plan: plan!, spans: allSpans, metrics };
  }

  /**
   * 构建/取回会话级冻结的 system prompt。首轮构建，之后整会话复用（保 provider 前缀缓存）。
   *
   * 冻结内容（会话内视为不变）：
   *   1. 基座（buildSystemPrompt：角色/能力/准则 + skill 清单 + MCP 资源）
   *   2. identity/preferences 记忆快照（"每次都注入"层，与 query 无关，会话内稳定）
   *   3. 账本指令段（buildLedgerInstruction）+ 选定的 preset few-shot
   *
   * 不含：facts/ongoing（改 recall_memory 按需查）、账本当前内容（每轮走 messages 末尾）。
   * key 含 planMode —— 切模式换基座描述会自然重新冻结。
   */
  private freezeSystemPrompt(
    session: Session,
    userMem: UserMemory | undefined,
    userInput: string | null,
    push: (kind: TraceEntry['kind'], data: unknown, turn: number) => void,
  ): string {
    const key = `${session.id}|${session.state.planMode ? 'plan' : 'loop'}`;
    const cached = this.frozenSystemPrompt.get(key);
    if (cached !== undefined) return cached;

    const skillList = this.skills?.describeForPrompt() || undefined;
    const base = buildSystemPrompt(this.registry, skillList, this.config.mcpResources);

    // identity/preferences 快照：空 query 只取"每次都注入"的两层（现按 tier==frozen 分区）。
    let memSnapshot = '';
    if (userMem) {
      // M2：freeze 前按召回反馈重算 tier（缓存安全的唯一时点）。动态模式默认开。
      // 年轻/无召回历史的记忆下 recomputeTiers 是 no-op；有变更才落盘（一会话一次，廉价）。
      if ((this.memory?.tiering ?? 'dynamic') === 'dynamic') {
        const delta = recomputeTiers(userMem);
        const changed = delta.promoted + delta.demoted + delta.dormant + delta.evicted;
        if (changed) {
          try { this.memory!.store.save(userMem); } catch { /* 落盘失败不阻塞冻结 */ }
          push('memory', { phase: 'retier', ...delta }, 0);
        }
      }
      memSnapshot = formatForPrompt(retrieveForQuery(userMem, '', 0));
      push('memory', { phase: 'freeze', snapshot: memSnapshot ? 'identity+preferences' : 'empty' }, 0);
    }

    // 账本指令 + preset few-shot（只影响引导，不含账本当前内容）。
    // preset 用**首轮的真实用户输入 + 账本 intent** 来选 —— 这是账本"自演化对话类型"的入口：
    // 排错会话选 debug preset、执行会话选 execution preset…（用 session.title 选会永远命中不了
    // 关键词、退化成 default）。freeze 只发生在首轮，选定后整会话冻结，符合保缓存约束。
    // 唤醒轮无用户输入 → 用 title 兜底（唤醒轮极少是首轮）。
    let ledgerSeg = '';
    if (this.ledger) {
      const ledger = this.ledger.store.load(session.id, this.ledger.language ?? 'zh');
      const presetQuery = userInput ?? session.title;
      const sel = pickPreset(ledger, presetQuery, this.ledger.presets);
      ledger.preset_used = sel.preset.name;
      try { this.ledger.store.save(ledger); } catch { /* preset_used 落盘失败不阻塞 */ }
      push('ledger', { phase: 'preset_frozen', preset: sel.preset.name, score: sel.score, reason: sel.reason }, 0);
      const fewShot = renderPresetFewShot(sel.preset);
      ledgerSeg = [buildLedgerInstruction(), fewShot].filter((s) => s && s.length).join('\n\n');
    }

    const frozen = [base, memSnapshot, ledgerSeg].filter((s) => s && s.length).join('\n\n');
    this.frozenSystemPrompt.set(key, frozen);
    return frozen;
  }

  private async maybeCompress(
    session: Session,
    turn: number,
    push: (kind: TraceEntry['kind'], data: unknown, turn: number) => void,
    extraSystemText?: string,
    currentLedger?: import('./ledger/index.ts').Ledger,
  ): Promise<void> {
    // 若配了账本 archive → 走新压缩路径（账本驱动、非破坏性归档）
    if (this.ledger?.archive) {
      const cfg = buildTriggerConfig(this.ledger.trigger);
      const out = tryCompress({
        session_id: session.id,
        history: session.history,
        ledger: currentLedger,
        extraSystemText: extraSystemText ?? '',
        turn,
        cfg,
        archive: this.ledger.archive,
        presets: this.ledger.presets,
        bias: this.ledger.feedback?.bias(),
      });
      if (out.compressed) {
        session.history = out.history;
        push('compress', compressTraceData(out), turn);
      }
      return;
    }

    // 兜底：旧的 FIFO 摘要路径（未启用账本 archive 时保持向后兼容）
    const result = await compressIfNeeded(
      session.history,
      this.config.context,
      (msgs) =>
        this.config.useLLMCompression
          ? llmSummarize(this.llm, msgs)
          : heuristicSummarize(msgs),
    );
    if (result.compressed) {
      session.history = result.history;
      push('compress', { folded: result.folded, kept: result.history.length }, turn);
    }
  }

  /**
   * 手动压缩当前会话（供 REPL 的 /compress 命令用）。
   * 与自动压缩走同一条账本驱动路径，但 force=true 跳过 token 阈值 —— 用户明确要求
   * 压缩就立刻压，不管有没有到 60%。仍要求 history 有可归档的中段（太短则 no-op）。
   *
   * 账本本身作为"活摘要"保留在会话里；被折叠的原始消息归档到 archive，可 recall_archive 拉回。
   * 返回压缩报告，UI 决定怎么展示；未启用账本 archive 时返回 { compressed:false }。
   */
  async compressNow(session: Session): Promise<ManualCompressResult> {
    if (!this.ledger?.archive) {
      return {
        compressed: false, archived: 0, merged: 0, deleted: 0, conversationClass: 'default',
        beforeTokens: 0, afterTokens: 0, savedPct: 0, ledgerItems: 0,
      };
    }
    const cfg = buildTriggerConfig(this.ledger.trigger);
    // 重建每轮临时拼进 system 的额外文本，好让 token 估算贴近真实输入。
    const ledger = this.ledger.store.load(session.id, this.ledger.language ?? 'zh');
    const skillList = this.skills?.describeForPrompt() || undefined;
    const base = buildSystemPrompt(this.registry, skillList, this.config.mcpResources);
    const ledgerText = ledger ? renderLedgerForPrompt(ledger) : '';
    const out = tryCompress({
      session_id: session.id,
      history: session.history,
      ledger,
      extraSystemText: [base, ledgerText].filter(Boolean).join('\n\n'),
      turn: session.trace.length,
      cfg,
      archive: this.ledger.archive,
      presets: this.ledger.presets,
      bias: this.ledger.feedback?.bias(),
      force: true,
    });
    if (out.compressed) {
      session.history = out.history;
      if (ledger) { try { this.ledger.store.save(ledger); } catch { /* 账本 archived_ref 落盘失败不阻塞 */ } }
      const entry: TraceEntry = { turn: 0, timestamp: Date.now(), kind: 'compress', data: compressTraceData(out) };
      session.trace.push(entry);
      this.config.onTrace?.(entry);
    }
    // 账本条目数：为 0 说明这轮没维护账本 —— 压缩只归档了原文、没有结构化摘要留在上下文。
    // UI 据此提醒用户，避免误以为压缩后上下文里还有"这段讲了啥"的浓缩。
    return { ...compressTraceData(out), ledgerItems: ledger ? totalItems(ledger) : 0 };
  }
}

/**
 * 注入后台任务结果时的长度上限 —— workflow 汇总 / bash 输出可能很大，
 * 一次全量注入会撑爆上下文、触发压缩抖动。截断后提示用 check_task 取全量。
 */
const INJECT_MAX_CHARS = 2000;
function truncateForInject(s: string): string {
  if (s.length <= INJECT_MAX_CHARS) return s;
  return `${s.slice(0, INJECT_MAX_CHARS)}…[已截断 ${s.length - INJECT_MAX_CHARS} 字符，完整结果用 check_task 取]`;
}

/** 数所有账本条目的总数，用于 trace 展示。 */
function totalItems(l: import('./ledger/index.ts').Ledger): number {
  let n = 0;
  const s = l.suggested;
  n += s.progress?.length ?? 0;
  n += s.findings?.length ?? 0;
  n += s.decisions?.length ?? 0;
  n += s.open_threads?.length ?? 0;
  n += s.blockers?.length ?? 0;
  n += s.artifacts?.length ?? 0;
  for (const arr of Object.values(l.custom)) n += arr.length;
  return n;
}
