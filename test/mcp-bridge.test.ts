import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeMCPTool, convertSchema } from '../src/mcp/bridge.ts';
import type { MCPToolDef } from '../src/mcp/types.ts';
import type { MCPClient } from '../src/mcp/client.ts';

describe('MCP bridge', () => {
  describe('convertSchema', () => {
    it('converts simple properties', () => {
      const result = convertSchema({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A name' },
          count: { type: 'number' },
        },
        required: ['name'],
      });

      assert.equal(result.type, 'object');
      assert.equal(result.properties.name.type, 'string');
      assert.equal(result.properties.name.description, 'A name');
      assert.equal(result.properties.count.type, 'number');
      assert.deepEqual(result.required, ['name']);
    });

    it('handles nested objects', () => {
      const result = convertSchema({
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: { port: { type: 'integer' } },
            required: ['port'],
          },
        },
      });

      const config = result.properties.config;
      assert.equal(config.type, 'object');
      assert.equal(config.properties!.port.type, 'integer');
      assert.deepEqual(config.required, ['port']);
    });

    it('handles arrays with items', () => {
      const result = convertSchema({
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
        },
      });

      assert.equal(result.properties.tags.type, 'array');
      assert.equal(result.properties.tags.items!.type, 'string');
    });

    it('handles enum', () => {
      const result = convertSchema({
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['fast', 'slow'] },
        },
      });

      assert.deepEqual(result.properties.mode.enum, ['fast', 'slow']);
    });

    it('defaults unknown type to string', () => {
      const result = convertSchema({
        type: 'object',
        properties: {
          weird: { type: 'null' as unknown } as unknown as { type: string },
        },
      });

      assert.equal(result.properties.weird.type, 'string');
    });

    it('handles empty properties', () => {
      const result = convertSchema({ type: 'object' });
      assert.deepEqual(result.properties, {});
    });
  });

  describe('bridgeMCPTool', () => {
    it('creates tool with double-underscore naming', () => {
      const mcpTool: MCPToolDef = {
        name: 'read_file',
        description: 'Read a file from disk',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      };

      // Use a mock client
      const mockClient = {
        callTool: async (name: string, args: Record<string, unknown>) => {
          return `content of ${args.path}`;
        },
      } as unknown as MCPClient;

      const tool = bridgeMCPTool('filesystem', mcpTool, mockClient);

      assert.equal(tool.name, 'filesystem__read_file');
      assert.match(tool.description, /\[MCP:filesystem\]/);
      assert.match(tool.description, /Read a file from disk/);
      assert.equal(tool.parameters.properties.path.type, 'string');
      assert.deepEqual(tool.parameters.required, ['path']);
    });

    it('handler delegates to client.callTool', async () => {
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const mockClient = {
        callTool: async (name: string, args: Record<string, unknown>) => {
          calls.push({ name, args });
          return 'result';
        },
      } as unknown as MCPClient;

      const tool = bridgeMCPTool('srv', {
        name: 'echo',
        inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      }, mockClient);

      const result = await tool.handler({ msg: 'hi' }, {} as never);
      assert.equal(result, 'result');
      assert.equal(calls[0].name, 'echo');
      assert.deepEqual(calls[0].args, { msg: 'hi' });
    });

    it('handler catches errors and returns structured error', async () => {
      const mockClient = {
        callTool: async () => { throw new Error('server crashed'); },
      } as unknown as MCPClient;

      const tool = bridgeMCPTool('broken', {
        name: 'fail',
        inputSchema: { type: 'object' },
      }, mockClient);

      const result = await tool.handler({}, {} as never) as { __mcp_error: boolean; message: string };
      assert.equal(result.__mcp_error, true);
      assert.match(result.message, /server crashed/);
    });

    it('uses tool name as description fallback', () => {
      const tool = bridgeMCPTool('x', {
        name: 'my_tool',
        inputSchema: { type: 'object' },
        // no description
      }, {} as unknown as MCPClient);

      assert.match(tool.description, /my_tool/);
    });
  });
});
