/**
 * 最简 MCP 服务器 —— 用于集成测试。
 *
 * 协议：JSON-RPC 2.0 over stdio（一行一个 JSON 对象）。
 *
 * 支持的方法：
 *   - initialize → 返回 capabilities (tools + resources + prompts)
 *   - tools/list → 返回一个 echo 工具
 *   - tools/call → echo 工具把参数原样返回
 *   - resources/list → 返回一个 test://hello 资源
 *   - resources/read → 返回 "Hello from echo server"
 *   - prompts/list → 返回一个 greet prompt
 *   - prompts/get → 返回一条 user message
 *
 * 用法: npx tsx test/fixtures/echo-server.ts
 */

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

interface Msg {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

function reply(id: number, result: unknown): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function errorReply(id: number, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: Msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (!msg.method) return;

  // Notifications（无 id）直接忽略
  if (msg.id === undefined) return;

  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: { name: 'echo-server', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      reply(msg.id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the input message',
            inputSchema: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'The message to echo' },
              },
              required: ['message'],
            },
          },
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number', description: 'First number' },
                b: { type: 'number', description: 'Second number' },
              },
              required: ['a', 'b'],
            },
          },
        ],
      });
      break;

    case 'tools/call': {
      const name = (msg.params as { name?: string })?.name;
      const args = (msg.params as { arguments?: Record<string, unknown> })?.arguments ?? {};
      if (name === 'echo') {
        reply(msg.id, {
          content: [{ type: 'text', text: String(args.message ?? '') }],
        });
      } else if (name === 'add') {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
        reply(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ sum }) }],
        });
      } else {
        errorReply(msg.id, -32602, `Unknown tool: ${name}`);
      }
      break;
    }

    case 'resources/list':
      reply(msg.id, {
        resources: [
          {
            uri: 'test://hello',
            name: 'hello',
            description: 'A greeting resource',
            mimeType: 'text/plain',
          },
        ],
      });
      break;

    case 'resources/read': {
      const uri = (msg.params as { uri?: string })?.uri;
      if (uri === 'test://hello') {
        reply(msg.id, {
          contents: [{ uri: 'test://hello', mimeType: 'text/plain', text: 'Hello from echo server' }],
        });
      } else {
        errorReply(msg.id, -32602, `Unknown resource: ${uri}`);
      }
      break;
    }

    case 'prompts/list':
      reply(msg.id, {
        prompts: [
          {
            name: 'greet',
            description: 'Generate a greeting',
            arguments: [{ name: 'name', description: 'Person to greet', required: true }],
          },
        ],
      });
      break;

    case 'prompts/get': {
      const promptName = (msg.params as { name?: string })?.name;
      const promptArgs = (msg.params as { arguments?: Record<string, string> })?.arguments ?? {};
      if (promptName === 'greet') {
        reply(msg.id, {
          messages: [
            { role: 'user', content: { type: 'text', text: `Hello, ${promptArgs.name ?? 'world'}!` } },
          ],
        });
      } else {
        errorReply(msg.id, -32602, `Unknown prompt: ${promptName}`);
      }
      break;
    }

    default:
      errorReply(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});
