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

export interface ToolContext {
  sessionId: string;
  sessionState: Record<string, unknown>;
  logger: (msg: string) => void;
  /** 可选 —— 仅当 agent 配置了 MemoryStore 时才有值。 */
  memory?: MemoryHandle;
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
