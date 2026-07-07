import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { MCPClient } from '../src/mcp/client.ts';
import { StdioTransport } from '../src/mcp/transport.ts';
import { bridgeMCPTool } from '../src/mcp/bridge.ts';

const ECHO_SERVER = resolve(import.meta.dirname!, 'fixtures', 'echo-server.ts');

describe('MCP integration (echo-server)', () => {
  it('full lifecycle: initialize → listTools → callTool → close', async () => {
    // Windows 下 spawn 不认裸 npx，要用 shell: true 或者走 node_modules/.bin。
    // StdioTransport 内部用的 spawn 没有 shell:true，所以直接传 node + --import tsx。
    const t = new StdioTransport({
      command: process.execPath,
      args: ['--import', 'tsx', ECHO_SERVER],
    });
    t.start();

    const client = new MCPClient(t, { timeout: 10_000 });

    try {
      // Initialize
      const caps = await client.initialize();
      assert(caps.tools);
      assert(caps.resources);
      assert(caps.prompts);

      // List tools
      const tools = await client.listTools();
      assert.equal(tools.length, 2);
      assert.equal(tools[0].name, 'echo');
      assert.equal(tools[1].name, 'add');

      // Call tool: echo
      const echoResult = await client.callTool('echo', { message: 'hello world' });
      assert.equal(echoResult, 'hello world');

      // Call tool: add
      const addResult = await client.callTool('add', { a: 3, b: 7 });
      assert.deepEqual(addResult, { sum: 10 });

      // List resources
      const resources = await client.listResources();
      assert.equal(resources.length, 1);
      assert.equal(resources[0].uri, 'test://hello');

      // Read resource
      const contents = await client.readResource('test://hello');
      assert.equal(contents[0].text, 'Hello from echo server');

      // List prompts
      const prompts = await client.listPrompts();
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].name, 'greet');

      // Get prompt
      const promptResult = await client.getPrompt('greet', { name: 'Alice' });
      assert.equal(promptResult.messages[0].content.text, 'Hello, Alice!');

      // Bridge a tool and call it through the Tool interface
      const bridged = bridgeMCPTool('echo_srv', tools[0], client);
      assert.equal(bridged.name, 'echo_srv__echo');
      const toolResult = await bridged.handler({ message: 'bridged!' }, {} as never);
      assert.equal(toolResult, 'bridged!');
    } finally {
      await client.close();
    }
  });
});
