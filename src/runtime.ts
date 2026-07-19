/**
 * 后端装配层 —— 把 LLM / registry / MCP / skills / 记忆 / 账本 / 归档 / 后台任务 / Agent
 * 全部组装好，返回一包依赖（Runtime）。**与界面无关**，供经典 REPL 和新 Ink UI 共用。
 *
 * UI 耦合的部分（审批弹窗、workflow 面板）通过参数注入：调用方（UI 层）提供 approve
 * 回调和 workflow observer，runtime 只负责把它们接到 agent / run_workflow 工具上。
 */
import { linagentHome, sessionsDir, memoryDir, skillsDir, ledgersDir, tasksDir, feedbackDir } from './storage.ts';
import { join as pathJoin } from 'node:path';
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { Agent, DEFAULT_AGENT_CONFIG } from './agent.ts';
import type { ApprovalDecision, ApprovalRequest } from './agent.ts';
import { SessionManager, FileSessionStore } from './session.ts';
import type { Session } from './session.ts';
import { buildDefaultRegistry, RISKY_TOOLS } from './tools/index.ts';
import type { ToolRegistry } from './tools/registry.ts';
import { buildLLMFromEnv } from './llm/client.ts';
import type { LLMClient } from './types.ts';
import { loadDotEnv } from './util/dotenv.ts';
import { FileMemoryStore } from './memory.ts';
import type { MemoryStore } from './memory.ts';
import { SkillRegistry } from './skills.ts';
import { setSandboxRoot } from './tools/fs.ts';
import { FileLedgerStore, FileArchiveStore, emergentClass, recallBiasFor, FeedbackController, FileFeedbackStore } from './ledger/index.ts';
import type { LedgerStore, ArchiveStore, Preset } from './ledger/index.ts';
import { buildRecallArchiveTool } from './tools/recall.ts';
import { buildRecallMemoryTool } from './tools/recall-memory.ts';
import { BackgroundTaskManager } from './tasks/manager.ts';
import { FileTaskStore } from './tasks/store.ts';
import { MCPManager, loadMCPConfig, buildMCPResourceTool, buildMCPPromptTool } from './mcp/index.ts';
import { buildRunWorkflowTool, type WorkflowObserver } from './tools/workflow.ts';
import { applyEarlyEnv, type CliConfig } from './cli.ts';

/** 装配好的一包运行时依赖。 */
export interface Runtime {
  llm: LLMClient;
  registry: ToolRegistry;
  sessions: SessionManager;
  memStore: MemoryStore;
  userId: string;
  ledgerStore: LedgerStore;
  archiveStore: ArchiveStore;
  taskManager: BackgroundTaskManager;
  skillRegistry: SkillRegistry;
  mcpManager?: MCPManager;
  mcpResourcesDesc: string;
  agent: Agent;
  workflowApprovalSet: Set<string>;
  /** 存储根目录信息（UI 顶部展示用）。 */
  home: { path: string; source: 'env' | 'cwd' | 'os' };
  /** 启动过程中的提示信息（迁移/恢复条数等），UI 决定怎么显示。 */
  notices: string[];
  /** 收尾：关 MCP 等。 */
  shutdown(): Promise<void>;
}

export interface RuntimeHooks {
  /** 工具审批回调。由 UI 层实现（弹面板）。 */
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** workflow 子 agent 状态观察者。由 UI 层实现（右侧面板）。 */
  workflowObserver?: WorkflowObserver;
}

function migrateLegacyV2Sessions(): number {
  const home = linagentHome().path;
  const legacy = pathJoin(home, 'sessions-v2');
  if (!existsSync(legacy)) return 0;
  const target = sessionsDir();
  let moved = 0;
  for (const f of readdirSync(legacy)) {
    if (!f.endsWith('.json')) continue;
    const dest = pathJoin(target, f);
    if (existsSync(dest)) continue;
    try { renameSync(pathJoin(legacy, f), dest); moved += 1; } catch { /* 跳过单个失败 */ }
  }
  return moved;
}

/**
 * 组装运行时。构建 LLM 失败会 throw（调用方负责友好报错 + 退出）。
 */
export async function buildRuntime(config: CliConfig, hooks: RuntimeHooks): Promise<Runtime> {
  loadDotEnv();
  applyEarlyEnv({ home: config.home });

  const llm = buildLLMFromEnv(process.env, config.llm); // 失败向上抛

  const registry = buildDefaultRegistry();
  const notices: string[] = [];

  const migrated = migrateLegacyV2Sessions();
  const store = new FileSessionStore(sessionsDir());
  const sessions = new SessionManager(store);
  if (migrated > 0) notices.push(`已从旧 sessions-v2/ 迁移 ${migrated} 个会话到 sessions/`);

  const home = linagentHome();
  const memStore = new FileMemoryStore(memoryDir());
  const userId = config.user ?? process.env.LINAGENT_USER ?? 'default';

  // 沙盒默认关闭（fs_write/fs_delete 仍走审批门）。
  void setSandboxRoot;

  // ─── MCP ───
  let mcpManager: MCPManager | undefined;
  let mcpResourcesDesc = '';
  const mcpConfig = loadMCPConfig();
  if (mcpConfig.size > 0) {
    mcpManager = new MCPManager();
    const { tools: mcpTools, resources: mcpResources, prompts: mcpPrompts, errors } = await mcpManager.startAll(mcpConfig);
    for (const tool of mcpTools) registry.register(tool);
    if (mcpResources.size > 0) registry.register(buildMCPResourceTool(mcpManager));
    if (mcpPrompts.size > 0) registry.register(buildMCPPromptTool(mcpManager));
    mcpResourcesDesc = mcpManager.describeResources();
    notices.push(`MCP: ${mcpTools.length} 工具, ${[...mcpResources.values()].flat().length} 资源, ${[...mcpPrompts.values()].flat().length} prompts (${mcpConfig.size} 台服务器)`);
    for (const { server, error } of errors) notices.push(`MCP ✗ ${server}: ${error}`);
  }

  const skillRegistry = new SkillRegistry(skillsDir());

  // ─── workflow ───
  const workflowApprovalSet = new Set(RISKY_TOOLS);
  registry.register(buildRunWorkflowTool({
    llm,
    registry,
    requireApproval: workflowApprovalSet,
    approve: hooks.approve,
    observer: hooks.workflowObserver,
  }));

  // ─── 账本 / 归档 / 后台任务 ───
  const ledgerStore = new FileLedgerStore(ledgersDir());
  const archiveStore = new FileArchiveStore(pathJoin(home.path, 'archives'));
  // Phase 2 反馈控制器：压缩与记忆共享的负反馈环。冷启动读慢环先验；recall 侧 record、
  // 压缩/沉淀侧 bias 都挂到同一个 controller（同一内存态引用，快环即时共享）。
  const feedback = new FeedbackController(new FileFeedbackStore(feedbackDir()), userId);
  registry.register(buildRecallArchiveTool(archiveStore));
  // recall_memory：按需召回 facts/ongoing（identity/preferences 已在冻结 system 里，不用查）。
  // 召回偏置与压缩共用**同一个 emergentClass**：类别从账本结构涌现（原语价值组合，非关键词），
  // 且喂入同一个反馈 bias。这样召回和压缩永远看同一个涌现类别，不再各算各的。
  //
  // presets 必须与 Agent 侧 LedgerConfig.presets 同源，否则冷启动（账本稀薄=weak）时压缩和召回
  // 会退回**不同**关键词先验、解出不同类别，违反"同一根轴"。当前 runtime 不配自定义 presets
  // （两侧都退回 BUILTIN，天然一致）；此处显式传同一个 ledgerPresets 引用，杜绝将来加了 presets
  // 却只配到一侧的潜伏分叉。
  const ledgerPresets: Preset[] | undefined = undefined;
  registry.register(buildRecallMemoryTool(memStore, userId, (sessionId) => {
    if (!sessionId) return undefined;
    try {
      const ledger = ledgerStore.load(sessionId, 'zh');
      const cls = emergentClass(ledger, feedback.bias(), ledgerPresets);
      return { class: cls, ...recallBiasFor(cls) };
    } catch {
      return undefined; // 账本加载失败 → 无偏置，退化为纯 Jaccard 召回
    }
  }, (hitKinds) => feedback.record(hitKinds as import('./ledger/index.ts').PrimitiveKind[])));

  const taskStore = new FileTaskStore(tasksDir());
  const taskManager = new BackgroundTaskManager(
    async (tool, args, sessionId) => {
      const sess = sessions.list().find((s: Session) => s.id === sessionId);
      return registry.invoke(tool, args, {
        sessionId,
        sessionState: sess?.state ?? {},
        logger: () => { /* 后台任务日志不进前台 */ },
      });
    },
    taskStore,
  );
  const restored = taskManager.restoreFromStore();
  if (restored > 0) notices.push(`恢复了 ${restored} 个中断的后台任务（标记为 interrupted）`);

  const agent = new Agent(llm, registry, {
    ...DEFAULT_AGENT_CONFIG,
    ...(config.maxTurns ? { maxTurns: config.maxTurns } : {}),
    context: {
      ...DEFAULT_AGENT_CONFIG.context,
      ...(config.contextMax ? { maxMessages: config.contextMax } : {}),
    },
    requireApproval: workflowApprovalSet,
    approve: hooks.approve,
    mcpResources: mcpResourcesDesc || undefined,
  }, {
    store: memStore,
    userId,
  }, skillRegistry, {
    store: ledgerStore,
    archive: archiveStore,
    language: 'zh',
    presets: ledgerPresets,   // 与 recall 闭包同源（见上），保证冷启动两侧解出同一类别
    feedback,
  }, taskManager);

  return {
    llm, registry, sessions, memStore, userId, ledgerStore, archiveStore,
    taskManager, skillRegistry, mcpManager, mcpResourcesDesc, agent,
    workflowApprovalSet, home, notices,
    async shutdown() { if (mcpManager) await mcpManager.shutdown(); },
  };
}
