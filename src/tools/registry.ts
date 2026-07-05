import type { JSONSchema, JSONSchemaProp, Tool, ToolContext } from '../types.ts';

export class ToolValidationError extends Error {}
export class ToolNotFoundError extends Error {}
export class ToolExecutionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

function validateProp(
  value: unknown,
  schema: JSONSchemaProp,
  path: string,
): void {
  if (value === undefined || value === null) {
    throw new ToolValidationError(`${path} is required（必填）`);
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') throw new ToolValidationError(`${path} must be a string（应为字符串）`);
      break;
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value))
        throw new ToolValidationError(`${path} must be a number（应为数字）`);
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        throw new ToolValidationError(`${path} must be an integer（应为整数）`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new ToolValidationError(`${path} must be a boolean（应为布尔）`);
      break;
    case 'array':
      if (!Array.isArray(value)) throw new ToolValidationError(`${path} must be an array（应为数组）`);
      if (schema.items) {
        value.forEach((v, i) => validateProp(v, schema.items!, `${path}[${i}]`));
      }
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value))
        throw new ToolValidationError(`${path} must be an object（应为对象）`);
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    throw new ToolValidationError(
      `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`,
    );
  }
}

export function validateArgs(schema: JSONSchema, args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new ToolValidationError('args must be an object（args 必须是对象）');
  }
  const obj = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in obj)) throw new ToolValidationError(`missing required arg（缺少必填参数）: ${key}`);
  }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (key in obj) validateProp(obj[key], propSchema, key);
  }
  return obj;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已被注册`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new ToolNotFoundError(`未找到工具 "${name}"`);
    return t;
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 拼进 LLM system prompt 的紧凑工具清单。 */
  describeAll(): string {
    return this.list()
      .map((t) => {
        const schema = JSON.stringify(t.parameters);
        return `- ${t.name}: ${t.description}\n  schema: ${schema}`;
      })
      .join('\n');
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<unknown> {
    const tool = this.get(name);
    const args = validateArgs(tool.parameters, rawArgs);
    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      if (err instanceof ToolValidationError) throw err;
      throw new ToolExecutionError(
        `工具 "${name}" 执行失败: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
