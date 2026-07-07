// ─── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ─── MCP 协议类型 ─────────────────────────────────────────────────────────────

export interface MCPServerCapabilities {
  tools?: Record<string, never>;
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArg[];
}

export interface MCPPromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

// ─── 配置类型 ──────────────────────────────────────────────────────────────────

export interface MCPServerConfigStdio {
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  enabled?: boolean;
}

export interface MCPServerConfigSse {
  transport: 'sse';
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  enabled?: boolean;
}

export type MCPServerConfig = MCPServerConfigStdio | MCPServerConfigSse;

export type MCPConfigFile = Record<string, MCPServerConfig>;
