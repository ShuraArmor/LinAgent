import type { Tool } from '../types.ts';
import type { MCPManager } from './manager.ts';

export function buildMCPResourceTool(manager: MCPManager): Tool {
  return {
    name: 'mcp_read_resource',
    description:
      '从 MCP 服务器读取一个资源。需要提供服务器名（见系统提示里的 MCP 资源列表）和资源 URI。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP 服务器名（如 "filesystem"、"github"）。' },
        uri: { type: 'string', description: '资源 URI（如 file:///path/to/file）。' },
      },
      required: ['server', 'uri'],
    },
    async handler(args) {
      const serverName = String(args.server);
      const uri = String(args.uri);
      const client = manager.getClient(serverName);
      if (!client) {
        return { ok: false, error: `未知 MCP 服务器: ${serverName}（可用: ${manager.listServers().join(', ') || '无'})` };
      }
      try {
        const contents = await client.readResource(uri);
        return { ok: true, contents };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function buildMCPPromptTool(manager: MCPManager): Tool {
  return {
    name: 'mcp_get_prompt',
    description:
      '获取 MCP 服务器提供的 prompt 模板。返回的 messages 可作为参考指令使用。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP 服务器名。' },
        name: { type: 'string', description: 'Prompt 模板名称。' },
        args: { type: 'object', description: '可选的 prompt 参数（键值对）。' },
      },
      required: ['server', 'name'],
    },
    async handler(args) {
      const serverName = String(args.server);
      const promptName = String(args.name);
      const promptArgs = (args.args as Record<string, string> | undefined) ?? {};
      const client = manager.getClient(serverName);
      if (!client) {
        return { ok: false, error: `未知 MCP 服务器: ${serverName}` };
      }
      try {
        const result = await client.getPrompt(promptName, promptArgs);
        return { ok: true, name: promptName, messages: result.messages };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
