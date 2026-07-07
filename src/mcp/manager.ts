import type { Tool } from '../types.ts';
import type { MCPServerConfig, MCPResource, MCPPrompt, MCPServerConfigSse } from './types.ts';
import { StdioTransport, SseTransport, type Transport } from './transport.ts';
import { MCPClient } from './client.ts';
import { bridgeMCPTool } from './bridge.ts';

export interface MCPStartResult {
  tools: Tool[];
  resources: Map<string, MCPResource[]>;
  prompts: Map<string, MCPPrompt[]>;
  errors: Array<{ server: string; error: string }>;
}

interface ServerEntry {
  client: MCPClient;
  transport: Transport;
  tools: Tool[];
  resources: MCPResource[];
  prompts: MCPPrompt[];
}

export class MCPManager {
  private servers = new Map<string, ServerEntry>();

  async startAll(config: Map<string, MCPServerConfig>): Promise<MCPStartResult> {
    const allTools: Tool[] = [];
    const allResources = new Map<string, MCPResource[]>();
    const allPrompts = new Map<string, MCPPrompt[]>();
    const errors: MCPStartResult['errors'] = [];

    for (const [name, conf] of config) {
      try {
        const entry = await this.startOne(name, conf);
        this.servers.set(name, entry);
        allTools.push(...entry.tools);
        if (entry.resources.length) allResources.set(name, entry.resources);
        if (entry.prompts.length) allPrompts.set(name, entry.prompts);
      } catch (err) {
        errors.push({ server: name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { tools: allTools, resources: allResources, prompts: allPrompts, errors };
  }

  private async startOne(name: string, conf: MCPServerConfig): Promise<ServerEntry> {
    const transport = this.createTransport(conf);
    const timeoutMs = conf.timeout ?? 30_000;

    // 启动 transport
    if (transport instanceof StdioTransport) {
      transport.start();
    } else if (transport instanceof SseTransport) {
      await transport.start();
    }

    const client = new MCPClient(transport, { timeout: timeoutMs });

    // 握手
    const caps = await client.initialize();

    // 获取能力对应的列表
    let tools: Tool[] = [];
    let resources: MCPResource[] = [];
    let prompts: MCPPrompt[] = [];

    if (caps.tools) {
      const mcpTools = await client.listTools();
      tools = mcpTools.map((t) => bridgeMCPTool(name, t, client));
    }

    if (caps.resources) {
      resources = await client.listResources();
    }

    if (caps.prompts) {
      prompts = await client.listPrompts();
    }

    return { client, transport, tools, resources, prompts };
  }

  private createTransport(conf: MCPServerConfig): Transport {
    if (conf.transport === 'sse') {
      const sseConf = conf as MCPServerConfigSse;
      return new SseTransport({ url: sseConf.url, headers: sseConf.headers });
    }
    // stdio (default)
    return new StdioTransport({
      command: conf.command!,
      args: (conf as { args?: string[] }).args,
      env: (conf as { env?: Record<string, string> }).env,
      cwd: (conf as { cwd?: string }).cwd,
    });
  }

  async shutdown(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [, entry] of this.servers) {
      closePromises.push(entry.client.close().catch(() => {}));
    }
    await Promise.all(closePromises);
    this.servers.clear();
  }

  getClient(serverName: string): MCPClient | undefined {
    return this.servers.get(serverName)?.client;
  }

  listServers(): string[] {
    return Array.from(this.servers.keys());
  }

  getServerTools(serverName: string): Tool[] {
    return this.servers.get(serverName)?.tools ?? [];
  }

  /**
   * 拼给 system prompt 的 MCP 资源描述段。
   * 空则返回空串（调用方据此决定要不要注入）。
   */
  describeResources(): string {
    const lines: string[] = [];
    for (const [name, entry] of this.servers) {
      for (const r of entry.resources) {
        const mime = r.mimeType ? ` (${r.mimeType})` : '';
        const desc = r.description ? ` — ${r.description}` : '';
        lines.push(`  - [${name}] ${r.uri}${mime}${desc}`);
      }
    }
    if (!lines.length) return '';
    return [
      '可用的 MCP 资源（用 mcp_read_resource 工具读取）：',
      ...lines,
    ].join('\n');
  }

  /**
   * 汇总所有服务器状态，给 /mcp 命令用。
   */
  status(): Array<{ name: string; tools: number; resources: number; prompts: number }> {
    const result: Array<{ name: string; tools: number; resources: number; prompts: number }> = [];
    for (const [name, entry] of this.servers) {
      result.push({
        name,
        tools: entry.tools.length,
        resources: entry.resources.length,
        prompts: entry.prompts.length,
      });
    }
    return result;
  }
}
