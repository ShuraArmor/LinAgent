/**
 * MCP 端到端探测：走真实的 loadMCPConfig + MCPManager，
 * 加载 .linagent/mcp.json → 启动 GitHub 服务器 → 列工具 → 真正调一次工具。
 * 仅用于手动验证，非测试。
 */
import { loadMCPConfig, MCPManager } from '../src/mcp/index.ts';

async function main() {
  console.log('[1] 加载配置 .linagent/mcp.json …');
  const config = loadMCPConfig();
  console.log(`    发现 ${config.size} 台服务器: ${[...config.keys()].join(', ') || '(无)'}`);
  if (config.size === 0) {
    console.log('    没有可用配置，退出。');
    return;
  }

  console.log('[2] 启动所有 MCP 服务器（握手 + 列能力）…');
  const manager = new MCPManager();
  const { tools, resources, prompts, errors } = await manager.startAll(config);

  for (const e of errors) console.log(`    ✗ ${e.server} 启动失败: ${e.error}`);
  console.log(`    ✓ 工具 ${tools.length} · 资源 ${[...resources.values()].flat().length} · prompts ${[...prompts.values()].flat().length}`);

  console.log('[3] 已连接服务器 & 工具清单：');
  for (const s of manager.status()) {
    console.log(`    ● ${s.name}: ${s.tools} 工具, ${s.resources} 资源, ${s.prompts} prompts`);
  }
  console.log('    前 15 个工具名：');
  for (const t of tools.slice(0, 15)) {
    console.log(`      · ${t.name}  — ${t.description.replace(/^\[MCP:\w+\]\s*/, '').slice(0, 60)}`);
  }
  if (tools.length > 15) console.log(`      … 还有 ${tools.length - 15} 个`);

  // [4] 真正调用一次工具：搜索仓库（只读、无副作用）
  const searchTool = tools.find((t) => t.name === 'github__search_repositories');
  if (searchTool) {
    console.log('\n[4] 调用 github__search_repositories { query: "modelcontextprotocol stars:>1000" } …');
    try {
      const result = await searchTool.handler(
        { query: 'modelcontextprotocol stars:>1000', perPage: 3 },
        { sessionId: 'probe', sessionState: {}, logger: () => {} },
      );
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      // MCP 工具通常返回 { content: [{type:'text', text:'...'}] }
      console.log('    ✓ 调用成功，返回前 500 字符：');
      console.log('    ' + text.slice(0, 500).replace(/\n/g, '\n    '));
    } catch (err) {
      console.log(`    ✗ 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('\n[4] 未找到 github__search_repositories 工具，跳过调用测试。');
  }

  console.log('\n[5] 关闭所有服务器 …');
  await manager.shutdown();
  console.log('    ✓ 已清理。探测结束。');
}

main().catch((err) => {
  console.error('探测脚本崩溃:', err);
  process.exit(1);
});
