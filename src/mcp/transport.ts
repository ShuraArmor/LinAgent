import { spawn, type ChildProcess } from 'node:child_process';
import type {
  JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
} from './types.ts';

// ─── Transport 接口 ──────────────────────────────────────────────────────────

export interface Transport {
  send(message: JsonRpcRequest | JsonRpcNotification): void;
  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): Promise<void>;
  readonly closed: boolean;
}

// ─── Stdio Transport ─────────────────────────────────────────────────────────

const GRACE_MS = 2_000;
const MAX_STDERR_LINES = 20;

export interface StdioTransportOpts {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class StdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private buffer = '';
  private messageHandler: ((msg: JsonRpcResponse | JsonRpcNotification) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private stderrLines: string[] = [];
  private _closed = false;

  constructor(private readonly opts: StdioTransportOpts) {}

  get closed(): boolean { return this._closed; }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        if (this.stderrLines.length >= MAX_STDERR_LINES) this.stderrLines.shift();
        this.stderrLines.push(l);
      }
    });

    this.child.on('error', (err) => {
      this._closed = true;
      this.closeHandler?.(`进程启动失败: ${err.message}`);
    });

    this.child.on('close', (code, signal) => {
      if (!this._closed) {
        this._closed = true;
        const reason = signal
          ? `进程被信号终止: ${signal}`
          : `进程退出: code=${code}`;
        this.closeHandler?.(reason);
      }
    });
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this._closed || !this.child?.stdin?.writable) {
      throw new Error('Transport 已关闭，无法发送消息');
    }
    const line = JSON.stringify(message) + '\n';
    this.child.stdin.write(line);
  }

  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (!this.child) return;

    const child = this.child;
    this.child = null;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      child.on('close', done);

      try { child.kill('SIGTERM'); } catch { /* noop */ }

      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        setTimeout(done, 200);
      }, GRACE_MS);
    });
  }

  getStderr(): string[] {
    return [...this.stderrLines];
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split('\n');
    // 最后一段不完整，留在 buffer 里
    this.buffer = lines.pop()!;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage;
        if (this.messageHandler && ('id' in msg || 'method' in msg)) {
          this.messageHandler(msg as JsonRpcResponse | JsonRpcNotification);
        }
      } catch {
        // 非 JSON 行忽略（某些 server 可能在 stdout 混入 log）
      }
    }
  }
}

// ─── SSE Transport ───────────────────────────────────────────────────────────

export interface SseTransportOpts {
  url: string;
  headers?: Record<string, string>;
}

export class SseTransport implements Transport {
  private messageHandler: ((msg: JsonRpcResponse | JsonRpcNotification) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private _closed = false;
  private abortController: AbortController | null = null;
  private postEndpoint: string;
  private sessionId: string | null = null;

  constructor(private readonly opts: SseTransportOpts) {
    this.postEndpoint = opts.url;
  }

  get closed(): boolean { return this._closed; }

  async start(): Promise<void> {
    this.abortController = new AbortController();

    const res = await fetch(this.opts.url, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        ...this.opts.headers,
      },
      signal: this.abortController.signal,
    });

    if (!res.ok) {
      throw new Error(`SSE 连接失败: HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new Error('SSE 响应缺少 body');
    }

    // 异步消费 SSE 流
    this.consumeStream(res.body).catch((err) => {
      if (!this._closed) {
        this._closed = true;
        this.closeHandler?.(err.name === 'AbortError' ? undefined : `SSE 流断开: ${err.message}`);
      }
    });
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this._closed) {
      throw new Error('Transport 已关闭，无法发送消息');
    }
    // 异步 POST，不阻塞调用方
    this.doPost(message).catch(() => {
      // POST 失败由 onMessage 的超时机制兜底
    });
  }

  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.abortController?.abort();
  }

  private async doPost(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.opts.headers,
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }
    const res = await fetch(this.postEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });
    // 服务器可能在响应头里给出 session id
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          currentData += line.slice(5).trim();
        } else if (line === '') {
          // 空行 = 事件边界
          if (currentEvent === 'endpoint' && currentData) {
            // 服务器告知 POST 端点
            try {
              const base = new URL(this.opts.url);
              this.postEndpoint = new URL(currentData, base).href;
            } catch { /* 保持原 URL */ }
          } else if (currentData) {
            try {
              const msg = JSON.parse(currentData) as JsonRpcMessage;
              this.messageHandler?.(msg as JsonRpcResponse | JsonRpcNotification);
            } catch { /* 忽略非 JSON */ }
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }
  }
}
