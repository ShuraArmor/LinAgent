import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { linagentHome } from '../storage.ts';
import type { MCPServerConfig, MCPConfigFile } from './types.ts';

/**
 * 查找并加载 mcp.json 配置文件。
 *
 * 查找顺序（第一个命中就用）：
 *   1. 项目本地 .linagent/mcp.json（允许项目级定制）
 *   2. linagentHome()/mcp.json（全局默认）
 *
 * 文件不存在 → 返回空 Map（静默，MCP 功能只是不生效）。
 */
export function loadMCPConfig(cwd: string = process.cwd()): Map<string, MCPServerConfig> {
  const result = new Map<string, MCPServerConfig>();

  const configPath = findConfigPath(cwd);
  if (!configPath) return result;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`mcp.json 解析失败 (${configPath}): ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`mcp.json 顶层必须是对象 (${configPath})`);
  }

  const file = parsed as MCPConfigFile;

  for (const [name, config] of Object.entries(file)) {
    if (!config || typeof config !== 'object') continue;

    // enabled: false → 跳过
    if (config.enabled === false) continue;

    // 验证
    const transport = config.transport ?? 'stdio';
    if (transport === 'stdio') {
      if (!('command' in config) || typeof config.command !== 'string' || !config.command.trim()) {
        throw new Error(`mcp.json: 服务器 "${name}" 缺少 command 字段`);
      }
    } else if (transport === 'sse') {
      if (!('url' in config) || typeof (config as { url?: unknown }).url !== 'string') {
        throw new Error(`mcp.json: 服务器 "${name}" (sse) 缺少 url 字段`);
      }
    } else {
      throw new Error(`mcp.json: 服务器 "${name}" transport 值无效: "${transport}"（支持 stdio / sse）`);
    }

    result.set(name, config);
  }

  return result;
}

/**
 * 返回找到的 mcp.json 绝对路径，找不到返回 null。
 */
export function findConfigPath(cwd: string = process.cwd()): string | null {
  // 1) 项目本地
  const local = resolve(cwd, '.linagent', 'mcp.json');
  if (existsSync(local)) return local;

  // 2) linagentHome
  const home = linagentHome(cwd);
  const global = join(home.path, 'mcp.json');
  if (existsSync(global)) return global;

  return null;
}
