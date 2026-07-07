import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Transport } from '../src/mcp/transport.ts';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from '../src/mcp/types.ts';

/**
 * MockTransport: 实现 Transport 接口，用于单元测试 MCPClient。
 * send() 把消息存到数组里，simulateResponse() 触发 message handler。
 */
export class MockTransport implements Transport {
  public sent: Array<JsonRpcRequest | JsonRpcNotification> = [];
  private messageHandler: ((msg: JsonRpcResponse | JsonRpcNotification) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private _closed = false;

  get closed(): boolean { return this._closed; }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this._closed) throw new Error('closed');
    this.sent.push(message);
  }

  onMessage(handler: (msg: JsonRpcResponse | JsonRpcNotification) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.closeHandler?.();
  }

  simulateResponse(msg: JsonRpcResponse | JsonRpcNotification): void {
    this.messageHandler?.(msg);
  }

  simulateClose(reason?: string): void {
    this._closed = true;
    this.closeHandler?.(reason);
  }
}

export { MockTransport as default };
