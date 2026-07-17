export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * 一次工具调用请求 —— 由 provider 原生协议产出（OpenAI tool_calls / Anthropic tool_use）。
 * args 在 client 层已经 parse 成对象（OpenAI 的 arguments 是 JSON 字符串，client 负责 parse）。
 */
export interface ToolCallRequest {
  /** provider 给的 call id（OpenAI call_xxx / Anthropic toolu_xxx）。回传结果时要对应。 */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * 工具参数 JSON 解析失败时的说明（如被 max_tokens 截断成残缺 JSON）。非空时，executor
   * 直接把它当作 tool_result 错误回喂给模型让它重发，而不是拿空 args 去跑校验（那会误报"缺参数"）。
   */
  parseError?: string;
  /**
   * 参数被 max_tokens 截断时的残缺 JSON 片段（内部字段）。client 用它自动续写拼接
   * （reconstructToolArgs）；续写成功后 args 被补全、本字段与 parseError 一并清除，
   * 上层完全无感。仅作 client 内部传递用，不进对话历史。
   */
  truncatedRaw?: string;
}

/**
 * thinking / reasoning 内容 —— 原样保存，多轮对话里要按 provider 规则回传。
 * - Anthropic：thinking block 必须原样回传（含 signature，改了报 400）
 * - DeepSeek：reasoning_content 多轮工具调用必须回传（否则 400）
 * client 层把 provider 的原始块存进 raw，回传时原样还原。
 */
export interface ThinkingBlock {
  provider: 'anthropic' | 'deepseek' | 'openai';
  /** provider 原始 thinking 结构（Anthropic 是 content block；DeepSeek 是字符串）。 */
  raw: unknown;
}

export interface Message {
  role: Role;
  content: string;
  /** role:"tool" 消息：用哪个工具产出的（展示用）。 */
  toolName?: string;
  /** role:"tool" 消息：对应哪个 tool call id。 */
  toolCallId?: string;
  /** assistant 消息发起的工具调用（可能并行多个）。回传历史时要带上。 */
  toolCalls?: ToolCallRequest[];
  /** assistant 消息的 thinking/reasoning —— 原样保存，回传按 provider 还原。 */
  thinking?: ThinkingBlock;
  /**
   * provider 的原始 assistant 消息（content blocks 等）。回传历史时原样带上，
   * 保证 thinking block / signature / tool_use 结构完整（尤其 Anthropic 要求）。
   */
  providerRaw?: unknown;
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProp {
  /**
   * 省略 type = 接受任意类型（string | object | ...）。
   * 用于 update_ledger 的 patch value：core.intent 要 string、add 到数组要 object，
   * 单一 type 表达不了，所以留空 + 靠 description 指导模型。
   */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: (string | number)[];
  items?: JSONSchemaProp;
  properties?: Record<string, JSONSchemaProp>;
  required?: string[];
}

export interface MemoryHandle {
  list(): Array<{
    id: string; layer: 'identity' | 'preferences' | 'facts' | 'ongoing';
    text: string; confidence: number; tags?: string[];
  }>;
  add(layer: 'identity' | 'preferences' | 'facts' | 'ongoing', text: string): {
    id: string; layer: string; text: string;
  };
  forget(id: string): { ok: boolean; forgotten?: string; error?: string };
}

export interface SkillHandle {
  /** 读某个 skill 的完整正文；未知 skill 抛错。 */
  load(name: string): { name: string; description: string; body: string; script?: { filename: string; filepath: string; content: string; runtime: string } };
  /** 列出所有可用 skill 的名字。 */
  names(): string[];
  /** 列出所有可用 skill 的名字和描述（不读正文）。 */
  list(): Array<{ name: string; description: string }>;
  /** 创建/覆盖一个 skill，写到磁盘并注册进内存。 */
  create(name: string, description: string, body: string, opts?: { script?: string; scriptFilename?: string; runtime?: string }): { ok: boolean; error?: string };
}

/** update_ledger 工具用来应用 patch 的 handle。由 agent.ts 注入当前会话的账本。 */
export interface LedgerHandle {
  applyPatches(patches: unknown[]): {
    applied: unknown[];
    failed: Array<{ patch: unknown; error: string }>;
    assigned_ids: (string | null)[];
  };
}

/** 后台任务状态。 */
export type TaskStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'canceled';

/** 一个后台任务的可落盘快照（不含运行时 promise）。 */
export interface BgTask {
  id: string;                 // t-<short>
  label: string;              // 人读描述（agent 给）
  tool: string;               // 底层转发的工具名
  args: unknown;              // 转发的参数
  status: TaskStatus;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  result?: unknown;           // done 时的工具结果
  error?: string;             // failed 时的错误
  /** 结果是否已注入过对话（防重复注入）。 */
  delivered: boolean;
}

/**
 * update_ledger / spawn_task 等工具用来操作后台任务的 handle。
 * 由 agent.ts 注入当前 session 的 BackgroundTaskManager。
 */
export interface TaskHandle {
  /** 转发一个工具到后台跑。graceMs 内完成则同步返回结果，否则返回 running + task_id。 */
  spawn(tool: string, args: unknown, label: string, graceMs?: number): Promise<
    | { status: 'done'; result: unknown }
    | { status: 'failed'; error: string }
    | { status: 'running'; task_id: string }
  >;
  check(id: string): BgTask | undefined;
  list(status?: TaskStatus): BgTask[];
  cancel(id: string): { ok: boolean; error?: string };
}

export interface ToolContext {
  sessionId: string;
  sessionState: Record<string, unknown>;
  logger: (msg: string) => void;
  /** 可选 —— 仅当 agent 配置了 MemoryStore 时才有值。 */
  memory?: MemoryHandle;
  /** 可选 —— 仅当 agent 配置了 SkillRegistry 时才有值。 */
  skills?: SkillHandle;
  /** 可选 —— 仅当 agent 启用了账本时才有值（供 update_ledger 工具用）。 */
  ledger?: LedgerHandle;
  /** 可选 —— 仅当 agent 配置了 BackgroundTaskManager 时才有值（供任务工具用）。 */
  tasks?: TaskHandle;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown> | unknown;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * 工具规格 —— 传给 provider 的工具定义（provider 无关的中间形态）。
 * client 层把它转成各家格式（OpenAI function / Anthropic tool）。
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/**
 * 一次 LLM 调用的结构化结果 —— 取代原来返回裸 string 的做法。
 * text 是模型的自然文本（工具调用前的叙述，= 旧的 thought）；
 * toolCalls 空数组表示模型选择直接回答（final answer）。
 */
export interface AssistantTurn {
  text: string;
  toolCalls: ToolCallRequest[];
  /** thinking/reasoning —— 原样保存供多轮回传。 */
  thinking?: ThinkingBlock;
  /** provider 原始 assistant 消息，push 回历史时原样带上（见 Message.providerRaw）。 */
  raw?: unknown;
}

/** 一次 chat 请求的参数。 */
export interface ChatRequest {
  messages: Message[];
  /** 传了就启用 provider 原生工具调用。 */
  tools?: ToolSpec[];
  /** 工具选择策略；不传默认 auto（有 tools 时）。 */
  toolChoice?: 'auto' | 'required' | 'none';
  temperature?: number;
  /** 输出 token 上限；不传时 client 用各自默认。 */
  maxTokens?: number;
  /** 正文文本增量回调（流式）。 */
  onDelta?: (chunk: string) => void;
  /** 思考/推理增量回调（流式）—— DeepSeek reasoning_content、Anthropic thinking。 */
  onReasoningDelta?: (chunk: string) => void;
  /** 用户打断信号：aborted 时中止在途请求（fetch 立即断流）。见 REPL 的 Esc 打断。 */
  signal?: AbortSignal;
}

export interface TraceEntry {
  turn: number;
  timestamp: number;
  kind: 'user_input' | 'llm_response' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'compress' | 'memory' | 'ledger' | 'plan';
  data: unknown;
}

export interface LLMChatOpts {
  temperature?: number;
  /** 输出 token 上限；不传时 client 用各自默认。 */
  maxTokens?: number;
  /** 流式模式下每收到一段文本就回调一次；不传等同于非流式。 */
  onDelta?: (chunk: string) => void;
  /**
   * 可选：JSON schema 约束输出（structured output）。用于 plan 模式的 planner / workflow
   * 那类"一次性产出结构化文档"的场景 —— OpenAI 走 response_format，Anthropic 走
   * 强制单工具。传了这个，complete() 保证返回一个符合 schema 的 JSON 字符串。
   */
  jsonSchema?: { name: string; schema: JSONSchema };
}

export interface LLMClient {
  name: string;
  /**
   * 结构化工具调用 —— agent 主决策循环用。返回 AssistantTurn（文本 + 工具调用 + thinking）。
   * 走 provider 原生工具协议（OpenAI tool_calls / Anthropic tool_use）。
   */
  chat(req: ChatRequest): Promise<AssistantTurn>;
  /**
   * 纯文本补全 —— 摘要、synthesize、结构化输出等"不需要工具循环"的场景用。
   * 传 opts.jsonSchema 时用约束解码保证输出是合法 JSON。
   */
  complete(messages: Message[], opts?: LLMChatOpts): Promise<string>;
}
