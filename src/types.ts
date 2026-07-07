export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProp>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProp {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
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

export interface ToolContext {
  sessionId: string;
  sessionState: Record<string, unknown>;
  logger: (msg: string) => void;
  /** 可选 —— 仅当 agent 配置了 MemoryStore 时才有值。 */
  memory?: MemoryHandle;
  /** 可选 —— 仅当 agent 配置了 SkillRegistry 时才有值。 */
  skills?: SkillHandle;
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

export interface AgentDecision {
  thought?: string;
  action: 'tool_call' | 'final_answer';
  tool?: ToolCall;
  final?: string;
}

export interface TraceEntry {
  turn: number;
  timestamp: number;
  kind: 'user_input' | 'llm_response' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'compress' | 'memory';
  data: unknown;
}

export interface LLMChatOpts {
  temperature?: number;
  /** 流式模式下每收到一段文本就回调一次；不传等同于非流式。 */
  onDelta?: (chunk: string) => void;
}

export interface LLMClient {
  name: string;
  chat(messages: Message[], opts?: LLMChatOpts): Promise<string>;
}
