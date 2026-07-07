import type { Transport } from './transport.ts';
import type {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
  MCPServerCapabilities, MCPToolDef, MCPResource,
  MCPResourceContent, MCPPrompt, MCPPromptMessage,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2024-11-05';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MCPClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private capabilities: MCPServerCapabilities | null = null;
  private timeoutMs: number;

  constructor(
    private readonly transport: Transport,
    opts?: { timeout?: number },
  ) {
    this.timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose((reason) => this.handleClose(reason));
  }

  get serverCapabilities(): MCPServerCapabilities | null {
    return this.capabilities;
  }

  async initialize(): Promise<MCPServerCapabilities> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'LinAgent', version: '1.0.0' },
    }) as { capabilities: MCPServerCapabilities; protocolVersion: string };

    this.capabilities = result.capabilities ?? {};

    // 发送 initialized 通知
    this.notify('notifications/initialized', {});

    return this.capabilities;
  }

  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.request('tools/list', {}) as { tools: MCPToolDef[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result.isError) {
      const text = result.content?.map((c) => c.text ?? '').join('\n') || 'MCP tool error';
      throw new Error(text);
    }
    // 返回 content 数组中所有 text 拼接
    if (result.content?.length === 1 && result.content[0].type === 'text') {
      // 尝试解析为 JSON，失败则返回原文
      try { return JSON.parse(result.content[0].text!); } catch { return result.content[0].text; }
    }
    return result.content;
  }

  async listResources(): Promise<MCPResource[]> {
    const result = await this.request('resources/list', {}) as { resources: MCPResource[] };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<MCPResourceContent[]> {
    const result = await this.request('resources/read', { uri }) as {
      contents: MCPResourceContent[];
    };
    return result.contents ?? [];
  }

  async listPrompts(): Promise<MCPPrompt[]> {
    const result = await this.request('prompts/list', {}) as { prompts: MCPPrompt[] };
    return result.prompts ?? [];
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<{ messages: MCPPromptMessage[] }> {
    const result = await this.request('prompts/get', {
      name,
      arguments: args ?? {},
    }) as { messages: MCPPromptMessage[] };
    return { messages: result.messages ?? [] };
  }

  async close(): Promise<void> {
    // reject 所有 pending
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('客户端关闭'));
      this.pending.delete(id);
    }
    await this.transport.close();
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.transport.closed) {
        reject(new Error('Transport 已关闭'));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时 (${this.timeoutMs}ms): ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      try {
        this.transport.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.transport.closed) return;
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    try { this.transport.send(msg); } catch { /* best-effort */ }
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    // Response（有 id）
    if ('id' in msg && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      const resp = msg as JsonRpcResponse;
      if (resp.error) {
        p.reject(new Error(`MCP 错误 [${resp.error.code}]: ${resp.error.message}`));
      } else {
        p.resolve(resp.result);
      }
    }
    // Notification（无 id）—— 目前不主动处理 server 推送
  }

  private handleClose(reason?: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason ?? 'Transport 意外关闭'));
      this.pending.delete(id);
    }
  }
}
