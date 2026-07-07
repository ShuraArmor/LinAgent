import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MCPClient } from '../src/mcp/client.ts';
import { MockTransport } from './mock-transport.ts';

describe('MCPClient', () => {
  let transport: MockTransport;
  let client: MCPClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new MCPClient(transport, { timeout: 2000 });
  });

  describe('initialize', () => {
    it('sends initialize request and initialized notification', async () => {
      const initPromise = client.initialize();

      // 应该发了一条 initialize request
      assert.equal(transport.sent.length, 1);
      const req = transport.sent[0] as { method: string; params?: unknown; id: number };
      assert.equal(req.method, 'initialize');
      assert.equal((req.params as { protocolVersion: string }).protocolVersion, '2024-11-05');

      // 模拟 server 回复
      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: { subscribe: false } },
          serverInfo: { name: 'test', version: '1.0' },
        },
      });

      const caps = await initPromise;
      assert.deepEqual(caps.tools, {});
      assert.deepEqual(caps.resources, { subscribe: false });

      // initialize 后应发 initialized 通知
      assert.equal(transport.sent.length, 2);
      const notif = transport.sent[1] as { method: string };
      assert.equal(notif.method, 'notifications/initialized');
    });
  });

  describe('listTools', () => {
    it('returns tools array from server', async () => {
      const promise = client.listTools();
      const req = transport.sent[0] as { id: number; method: string };
      assert.equal(req.method, 'tools/list');

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: [
            { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      });

      const tools = await promise;
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'echo');
    });
  });

  describe('callTool', () => {
    it('returns tool result content', async () => {
      const promise = client.callTool('echo', { message: 'hi' });
      const req = transport.sent[0] as { id: number; params?: { name: string; arguments: unknown } };
      assert.equal(req.params?.name, 'echo');
      assert.deepEqual(req.params?.arguments, { message: 'hi' });

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: 'hi' }] },
      });

      const result = await promise;
      assert.equal(result, 'hi');
    });

    it('throws on isError response', async () => {
      const promise = client.callTool('bad', {});
      const req = transport.sent[0] as { id: number };

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: 'something went wrong' }], isError: true },
      });

      await assert.rejects(promise, /something went wrong/);
    });
  });

  describe('listResources', () => {
    it('returns resources array', async () => {
      const promise = client.listResources();
      const req = transport.sent[0] as { id: number };

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: { resources: [{ uri: 'test://x', name: 'x' }] },
      });

      const resources = await promise;
      assert.equal(resources.length, 1);
      assert.equal(resources[0].uri, 'test://x');
    });
  });

  describe('readResource', () => {
    it('returns resource contents', async () => {
      const promise = client.readResource('test://x');
      const req = transport.sent[0] as { id: number; params?: { uri: string } };
      assert.equal(req.params?.uri, 'test://x');

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: { contents: [{ uri: 'test://x', text: 'content here' }] },
      });

      const contents = await promise;
      assert.equal(contents[0].text, 'content here');
    });
  });

  describe('listPrompts', () => {
    it('returns prompts array', async () => {
      const promise = client.listPrompts();
      const req = transport.sent[0] as { id: number };

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: { prompts: [{ name: 'greet', description: 'Say hi' }] },
      });

      const prompts = await promise;
      assert.equal(prompts[0].name, 'greet');
    });
  });

  describe('getPrompt', () => {
    it('returns prompt messages', async () => {
      const promise = client.getPrompt('greet', { name: 'Alice' });
      const req = transport.sent[0] as { id: number; params?: { name: string; arguments: unknown } };
      assert.equal(req.params?.name, 'greet');

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        result: { messages: [{ role: 'user', content: { type: 'text', text: 'Hello, Alice!' } }] },
      });

      const result = await promise;
      assert.equal(result.messages[0].content.text, 'Hello, Alice!');
    });
  });

  describe('timeout', () => {
    it('rejects after timeout', async () => {
      // client 设了 2000ms timeout
      const promise = client.listTools();
      // 不回复 → 应超时
      await assert.rejects(promise, /超时/);
    });
  });

  describe('transport close', () => {
    it('rejects pending requests when transport closes', async () => {
      const promise = client.listTools();
      transport.simulateClose('process died');
      await assert.rejects(promise, /process died/);
    });
  });

  describe('close', () => {
    it('rejects all pending and closes transport', async () => {
      const p1 = client.listTools();
      const p2 = client.listResources();
      await client.close();
      await assert.rejects(p1, /客户端关闭/);
      await assert.rejects(p2, /客户端关闭/);
      assert.equal(transport.closed, true);
    });
  });

  describe('JSON-RPC error response', () => {
    it('rejects with error message', async () => {
      const promise = client.callTool('unknown', {});
      const req = transport.sent[0] as { id: number };

      transport.simulateResponse({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: 'Unknown tool' },
      });

      await assert.rejects(promise, /Unknown tool/);
    });
  });
});
