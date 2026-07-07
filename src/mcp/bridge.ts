import type { Tool, JSONSchema, JSONSchemaProp } from '../types.ts';
import type { MCPClient } from './client.ts';
import type { MCPToolDef } from './types.ts';

/**
 * 把一个 MCP 工具定义转换为 LinAgent Tool 对象。
 *
 * 命名策略：serverName__toolName（双下划线分隔）。
 * handler 通过闭包持有 client 引用，调用时委托给 client.callTool()。
 */
export function bridgeMCPTool(
  serverName: string,
  mcpTool: MCPToolDef,
  client: MCPClient,
): Tool {
  const fullName = `${serverName}__${mcpTool.name}`;
  return {
    name: fullName,
    description: `[MCP:${serverName}] ${mcpTool.description ?? mcpTool.name}`,
    parameters: convertSchema(mcpTool.inputSchema),
    async handler(args) {
      try {
        return await client.callTool(mcpTool.name, args);
      } catch (err) {
        return { __mcp_error: true, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * 将 MCP inputSchema（标准 JSON Schema 子集）转换为 LinAgent 的 JSONSchema 类型。
 */
export function convertSchema(input: MCPToolDef['inputSchema']): JSONSchema {
  const properties: Record<string, JSONSchemaProp> = {};

  if (input.properties) {
    for (const [key, raw] of Object.entries(input.properties)) {
      properties[key] = convertProp(raw);
    }
  }

  return {
    type: 'object',
    properties,
    required: input.required,
  };
}

function convertProp(raw: unknown): JSONSchemaProp {
  if (typeof raw !== 'object' || raw === null) {
    return { type: 'string' };
  }

  const obj = raw as Record<string, unknown>;
  const typeName = normalizeType(obj.type);

  const prop: JSONSchemaProp = { type: typeName };

  if (typeof obj.description === 'string') {
    prop.description = obj.description;
  }

  if (Array.isArray(obj.enum)) {
    prop.enum = obj.enum.filter((v): v is string | number =>
      typeof v === 'string' || typeof v === 'number',
    );
  }

  if (typeName === 'array' && obj.items) {
    prop.items = convertProp(obj.items);
  }

  if (typeName === 'object' && obj.properties && typeof obj.properties === 'object') {
    prop.properties = {};
    for (const [k, v] of Object.entries(obj.properties as Record<string, unknown>)) {
      prop.properties[k] = convertProp(v);
    }
    if (Array.isArray(obj.required)) {
      prop.required = obj.required.filter((r): r is string => typeof r === 'string');
    }
  }

  return prop;
}

function normalizeType(t: unknown): JSONSchemaProp['type'] {
  const valid = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;
  if (typeof t === 'string' && (valid as readonly string[]).includes(t)) {
    return t as JSONSchemaProp['type'];
  }
  return 'string';
}
