import type { LLMClient, Message, MemoryHandle, TraceEntry } from './types.ts';
import type { Session } from './session.ts';
import type { ToolRegistry } from './tools/registry.ts';
import { ToolNotFoundError, ToolValidationError, ToolExecutionError } from './tools/registry.ts';
import { parseAgentOutput } from './llm/parser.ts';
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
  addManual, forget, mergeCandidates, retrieveForQuery, formatForPrompt,
} from './memory.ts';
import { extractFacts } from './extractor.ts';

/** 工具审批的返回值。 */
export type ApprovalDecision = 'approve' | 'approve_session' | 'deny';

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
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 32),
  context: {
    maxMessages: Number(process.env.AGENT_CONTEXT_MAX_MESSAGES ?? DEFAULT_CONTEXT_CONFIG.maxMessages),
    keepRecent: DEFAULT_CONTEXT_CONFIG.keepRecent,
  },
  useLLMCompression: true,
};

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
}

export interface MemoryConfig {
  store: MemoryStore;
  userId: string;
  /** 按关键词命中注入的 facts / ongoing 条数上限，默认 5。 */
  topK?: number;
  /** 是否跳过每轮结束后的自动抽取（memory 工具仍可用）。默认 false。 */
  disableIngest?: boolean;
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
  constructor(
    private readonly llm: LLMClient,
    private readonly registry: ToolRegistry,
    private readonly config: AgentConfig = DEFAULT_AGENT_CONFIG,
    private readonly memory?: MemoryConfig,
  ) {}

  async chat(
    session: Session,
    userInput: string,
    hooks?: {
      onDelta?: (chunk: string, turn: number) => void;
      onTurnStart?: (turn: number) => void;
      /**
       * 每产生一条 trace 都会回调一次。**per-call**，比 config.onTrace 优先级高。
       * REPL 想每轮换 handler 时用这个 —— 不用动 config 单例。
       */
      onTrace?: (entry: TraceEntry) => void;
    },
  ): Promise<RunResult> {
    const startTrace = session.trace.length;
    const push = (kind: TraceEntry['kind'], data: unknown, turn: number) => {
      const entry: TraceEntry = { turn, timestamp: Date.now(), kind, data };
      session.trace.push(entry);
      hooks?.onTrace?.(entry);       // per-call handler 优先
      this.config.onTrace?.(entry);  // config-level handler 兜底
    };

    session.history.push({ role: 'user', content: userInput });
    push('user_input', { text: userInput }, 0);

    // 先做一次压缩，让上下文跨会话保持在可控大小。
    await this.maybeCompress(session, 0, push);

    // 跨会话记忆：为本次输入检索相关 fact，拼进 system prompt。
    // identity / preferences 每次都注入；facts / ongoing 按关键词命中，见 retrieveForQuery。
    const systemPromptBase = buildSystemPrompt(this.registry);
    let memoryPrompt = '';
    let userMem: UserMemory | undefined;
    if (this.memory) {
      userMem = this.memory.store.load(this.memory.userId);
      const relevant = retrieveForQuery(userMem, userInput, this.memory.topK ?? 5);
      memoryPrompt = formatForPrompt(relevant);
      push('memory', { retrieved: relevant.length, userId: this.memory.userId }, 0);
    }
    const systemPrompt = memoryPrompt
      ? `${systemPromptBase}\n\n${memoryPrompt}`
      : systemPromptBase;

    let finalAnswer: string | null = null;
    let turn = 0;

    while (turn < this.config.maxTurns) {
      turn += 1;
      hooks?.onTurnStart?.(turn);

      const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...session.history];

      let raw: string;
      try {
        raw = await this.llm.chat(messages, {
          onDelta: hooks?.onDelta ? (chunk) => hooks.onDelta!(chunk, turn) : undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push('error', { where: 'llm', message: msg }, turn);
        session.history.push({
          role: 'assistant',
          content: `[agent error: LLM call failed — ${msg}]`,
        });
        finalAnswer = `抱歉，语言模型调用失败 (language model call failed): ${msg}`;
        break;
      }

      push('llm_response', { raw }, turn);

      let decision;
      try {
        decision = parseAgentOutput(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push('error', { where: 'parse', message: msg, raw }, turn);
        // 把错误信息回喂给模型，给它一次自己修正格式的机会。
        session.history.push({ role: 'assistant', content: raw });
        session.history.push({
          role: 'user',
          content:
            `你上一条消息无法解析（${msg}）。请只输出规定格式的那一个 JSON 对象，前后不要有任何其它文字。`,
        });
        continue;
      }

      // 把助手的原始 JSON 回复也塞进历史，让它以后能引用自己的推理。
      session.history.push({ role: 'assistant', content: raw });

      if (decision.action === 'final_answer') {
        push('final', { answer: decision.final, thought: decision.thought }, turn);
        finalAnswer = decision.final!;
        break;
      }

      // tool_call
      const call = decision.tool!;

      // 审批门：若工具在 requireApproval 里，且尚未获得 session 级放行，弹审批。
      // 存进 session.state 的是 string[]（Set 无法 JSON 序列化，重启会变成 {} 而崩溃）。
      //
      // 重要：tool_call 的 trace 事件在**审批通过之后**才推。REPL 的 liveTrace 会用它触发
      // "执行中" spinner —— 如果推早了，审批面板还在弹用户还在选择，屏幕下方就会先出现
      // 一个转圈说"执行 xxx"，看起来像工具已经在跑了。
      let approvalDenied: string | null = null;
      if (this.config.requireApproval?.has(call.name)) {
        const raw = session.state.__approvedTools;
        const approved: string[] = Array.isArray(raw) ? (raw as string[]) : [];
        if (!approved.includes(call.name)) {
          if (!this.config.approve) {
            approvalDenied = '当前 agent 未配置审批器，且该工具需要审批 → fail-closed 拒绝';
          } else {
            const decisionA = await this.config.approve({
              toolName: call.name, args: call.args, turn, sessionId: session.id,
            });
            push('memory', { phase: 'approval', tool: call.name, decision: decisionA }, turn);
            if (decisionA === 'deny') {
              approvalDenied = '用户拒绝了本次工具调用';
            } else if (decisionA === 'approve_session') {
              approved.push(call.name);
              session.state.__approvedTools = approved;
            }
          }
        }
      }

      // 审批已完成（通过 / 拒绝 / 未配置审批器兜底），现在再推 tool_call trace，
      // 让 REPL 只在真要执行时才起 spinner。
      push('tool_call', { name: call.name, args: call.args, thought: decision.thought }, turn);

      let toolContent: string;
      if (approvalDenied) {
        toolContent = JSON.stringify({
          ok: false,
          error: { kind: 'denied', message: approvalDenied },
        });
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
          });
          toolContent = JSON.stringify({ ok: true, result });
          push('tool_result', { name: call.name, result }, turn);
        } catch (err) {
          const kind =
            err instanceof ToolNotFoundError
              ? 'not_found'
              : err instanceof ToolValidationError
              ? 'validation'
              : err instanceof ToolExecutionError
              ? 'execution'
              : 'unknown';
          const message = err instanceof Error ? err.message : String(err);
          toolContent = JSON.stringify({ ok: false, error: { kind, message } });
          push('error', { where: 'tool', name: call.name, kind, message }, turn);
        }
      }

      session.history.push({
        role: 'tool',
        toolName: call.name,
        content: toolContent,
      });

      await this.maybeCompress(session, turn, push);
    }

    if (finalAnswer === null) {
      finalAnswer = `已达 max turns (${this.config.maxTurns}) 上限，仍未产出最终答复。`;
      push('error', { where: 'loop', message: finalAnswer }, turn);
      session.history.push({ role: 'assistant', content: `[agent] ${finalAnswer}` });
    }

    // 抽取（ingest）：从本轮对话里提取持久事实，合并到用户 memory 中。
    // 同步执行，但整个块用 try/catch 包住，抽取器出 bug 绝不能拖垮一次聊天。
    if (this.memory && !this.memory.disableIngest && userMem) {
      try {
        const transcript = `user: ${userInput}\nassistant: ${finalAnswer}`;
        const { candidates } = await extractFacts(this.llm, transcript);
        if (candidates.length) {
          const report = mergeCandidates(userMem, candidates,
            { session: session.id, turn }, Date.now());
          this.memory.store.save(userMem);
          push('memory', {
            phase: 'ingest',
            added: report.added.length,
            updated: report.updated.length,
            superseded: report.superseded.length,
          }, turn);
        }
      } catch (err) {
        push('error', { where: 'memory_ingest', message: (err as Error).message }, turn);
      }
    }

    return {
      finalAnswer,
      turns: turn,
      trace: session.trace.slice(startTrace),
      systemPromptBase,
      memoryPrompt,
    };
  }

  private async maybeCompress(
    session: Session,
    turn: number,
    push: (kind: TraceEntry['kind'], data: unknown, turn: number) => void,
  ): Promise<void> {
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
}
