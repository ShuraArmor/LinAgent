/**
 * v2 REPL —— 让 planner / executor 分离的 runtime 也有个能实操的界面。
 *
 * 跟 v1 REPL 的区别：
 *   - 底层跑 V2Agent（planner → verifier → executor → reflector）
 *   - 显示"Plan"树、并行执行的 span 流、以及 planner/reflector/synth 的调用次数
 *   - 会话文件独立目录（v2 的 session 语义不同，别跟 v1 混）
 *   - 不接入跨会话记忆 —— 那是正交能力，想要就跑 v1 REPL
 */

import * as readline from 'node:readline';
import { join } from 'node:path';
import { linagentHome } from './storage.ts';
import { V2Agent } from './v2/agent.ts';
import { SessionManager, FileSessionStore } from './session.ts';
import { buildDefaultRegistry, RISKY_TOOLS } from './tools/index.ts';
import { buildLLMFromEnv } from './llm/client.ts';
import { loadDotEnv } from './util/dotenv.ts';
import { c, hr, symbols } from './ui/ansi.ts';
import { banner, userLine, finalBox, errorLine, sessionRow } from './ui/render.ts';
import { Spinner } from './ui/spinner.ts';
import { select } from './ui/prompt.ts';
import { planTree, renderSpan, metricsLine, spanDump } from './ui/v2-render.ts';
import { breakdown as tokenBreakdown, contextWindow } from './tokens.ts';
import { tokenLine, tokenBarChart } from './ui/tokens.ts';
import { plannerSystemPrompt } from './v2/planner.ts';
import type { Plan } from './v2/plan.ts';
import type { ExecSpan } from './v2/executor.ts';
import { mkdirSync } from 'node:fs';
import { MCPManager, loadMCPConfig, buildMCPResourceTool, buildMCPPromptTool } from './mcp/index.ts';

type V2Decision = 'approve' | 'approve_session' | 'deny';

async function main() {
  loadDotEnv();

  let llm;
  try {
    llm = buildLLMFromEnv();
  } catch (err) {
    console.error(c.red(`\n无法启动: ${(err as Error).message}\n`));
    console.error(c.gray(`请把 .env.example 复制为 .env，至少填两项：`));
    console.error(c.gray(`  LLM_PROVIDER=<preset 名>`));
    console.error(c.gray(`  LLM_API_KEY=<你的 key>       # ollama 本地无需 key\n`));
    process.exit(1);
  }

  const registry = buildDefaultRegistry();

  // ─── MCP ───
  let mcpManager: MCPManager | undefined;
  const mcpConfig = loadMCPConfig();
  if (mcpConfig.size > 0) {
    mcpManager = new MCPManager();
    const { tools: mcpTools, resources: mcpResources, prompts: mcpPrompts, errors } = await mcpManager.startAll(mcpConfig);
    for (const tool of mcpTools) registry.register(tool);
    if (mcpResources.size > 0) registry.register(buildMCPResourceTool(mcpManager));
    if (mcpPrompts.size > 0) registry.register(buildMCPPromptTool(mcpManager));
    console.log(c.gray(`MCP: ${mcpTools.length} 工具, ${[...mcpResources.values()].flat().length} 资源  (${mcpConfig.size} 台服务器)`));
    for (const { server, error } of errors) {
      console.log(c.red(`  ${symbols.cross} ${server}: ${error}`));
    }
  }

  // v2 session 独占目录，避免和 v1 会话文件混
  const home = linagentHome();
  const sessDir = join(home.path, 'sessions-v2');
  mkdirSync(sessDir, { recursive: true });
  const store = new FileSessionStore(sessDir);
  const sessions = new SessionManager(store);

  console.log(banner(llm.name, registry.list().map((t) => t.name)));
  console.log(c.bold(c.cyan('[v2 REPL]')) + c.gray('  planner → verifier → executor → reflector'));
  const sourceLabel: Record<'env' | 'cwd' | 'os', string> = {
    env: 'LINAGENT_HOME',
    cwd: '项目本地 .linagent/',
    os:  '系统缓存目录',
  };
  console.log(c.gray(`存储: ${c.underline(sessDir)}  ${c.dim(`(${sourceLabel[home.source]})`)}`));
  if (sessions.list().length > 0) {
    console.log(c.gray(`已恢复 ${sessions.list().length} 个 v2 会话`));
  }

  let current = sessions.list()[0] ?? sessions.create('v2-window-1');
  console.log(c.gray(`当前会话: ${c.cyan(current.id)} (${current.title})`));
  console.log(c.dim(`命令: /new [标题] · /list · /switch <id> · /rm <id> · /trace · /tokens · /reset · /help · /exit`));
  console.log(hr(), '\n');

  // 交互式审批（跟 v1 一样）
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = () => rl.setPrompt(`${c.bgMagenta(c.bold(` v2:${current.title} `))} ${c.cyan(symbols.arrow)} `);
  prompt();
  let lastSpans: ExecSpan[] = [];

  const approve = async (req: { toolName: string; args: Record<string, unknown>; stepId: string; sessionId: string }): Promise<V2Decision> => {
    rl.pause();
    try {
      const argsPreview = JSON.stringify(req.args, null, 2);
      const detail = [
        `Step: ${req.stepId}    会话: ${req.sessionId}`,
        `工具: ${req.toolName}`,
        `参数:`,
        ...argsPreview.split('\n').map((l) => '  ' + l),
      ];
      const choice = await select<V2Decision>({
        title: `⚠  v2 想调用高影响工具：${req.toolName}`,
        detail,
        options: [
          { value: 'approve',         label: '允许一次',      description: '这次调用允许，之后同类还会问', hotkey: 'y' },
          { value: 'approve_session', label: '本会话都允许',  description: '当前 session 内该工具直接放行', hotkey: 'a' },
          { value: 'deny',            label: '拒绝',          description: '把"用户拒绝"当结果回喂给 reflector', hotkey: 'n' },
        ],
      });
      return choice ?? 'deny';
    } finally {
      rl.resume();
    }
  };

  const agent = new V2Agent(llm, registry, {
    requireApproval: new Set(RISKY_TOOLS),
    approve,
  });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'exit':
        case 'quit':
          rl.close(); return;
        case 'help':
          console.log(c.gray('命令: /new [标题] · /list · /switch <id> · /rm <id> · /trace · /tokens · /reset · /exit'));
          break;
        case 'new': {
          current = sessions.create(rest.join(' ') || undefined);
          lastSpans = [];
          console.log(c.green(`${symbols.check} 已创建并切换到 ${c.cyan(current.id)} (${current.title})`));
          prompt();
          break;
        }
        case 'list': {
          const all = sessions.list();
          if (!all.length) { console.log(c.gray('(暂无会话)')); break; }
          for (const s of all) {
            console.log(sessionRow(s.id, s.title, s.history.length, 0, s.id === current.id));
          }
          break;
        }
        case 'switch': {
          const id = rest[0];
          const target = id ? sessions.get(id) : undefined;
          if (!target) { console.log(c.red(`没有此会话: ${id}`)); break; }
          current = target;
          lastSpans = [];
          console.log(c.green(`${symbols.check} 已切换到 ${c.cyan(current.id)} (${current.title})`));
          prompt();
          break;
        }
        case 'rm': {
          const id = rest[0];
          if (!id) { console.log(c.red('用法: /rm <id>')); break; }
          if (id === current.id) { console.log(c.red('不能删除当前活动会话 —— 请先切换')); break; }
          if (sessions.delete(id)) console.log(c.green(`${symbols.check} 已删除 ${id}`));
          else console.log(c.red(`没有此会话: ${id}`));
          break;
        }
        case 'trace': {
          if (!lastSpans.length) { console.log(c.gray('(本会话尚未执行过 plan)')); break; }
          console.log(spanDump(lastSpans));
          break;
        }
        case 'reset': {
          current.history = [];
          current.state = {};
          current.trace = [];
          lastSpans = [];
          sessions.save(current);
          console.log(c.green(`${symbols.check} 会话已重置`));
          break;
        }
        case 'tokens':
        case 'token': {
          // v2 每次调 planner 时都会拼 plannerSystemPrompt(registry) 作为 system
          // 段——它不在 history 里，得单独算进去，否则 system 那栏永远是 0。
          const extras = { systemBase: plannerSystemPrompt(registry) };
          console.log(tokenBarChart(tokenBreakdown(current.history, extras), contextWindow()));
          break;
        }
        default:
          console.log(c.red(`未知命令: /${cmd}`));
      }
      rl.prompt();
      return;
    }

    console.log(userLine(text));
    const start = Date.now();
    const spinner = new Spinner('planner 正在生成 Plan');
    spinner.start();

    let plan: Plan | null = null;
    const spans: ExecSpan[] = [];
    let lastPrintedSpanId = '';

    const onSpan = (span: ExecSpan) => {
      spans.push(span);
      // 每个 span 有 start + complete 两次；只在完成时打印
      if (!span.endedAt) {
        // 刚开始运行 —— 更新 spinner 描述
        if (span.kind === 'step') spinner.updateAndReset(`执行 ${span.name}`);
        else if (span.kind === 'plan') spinner.updateAndReset('executor 开始执行 plan');
        return;
      }
      if (span.id === lastPrintedSpanId) return;
      lastPrintedSpanId = span.id;
      spinner.stop();
      console.log(renderSpan(span, spans));
      // step 结束后立刻重启 spinner，让下一步的等待仍有反馈
      if (span.kind === 'step') spinner.start('等待下一步');
    };

    try {
      const res = await agent.chat(current, text, { onSpan });
      spinner.stop();

      // 找到最终的 plan（reflector 可能替换过，取最后一份）
      plan = res.plan;
      lastSpans = res.spans;

      console.log('\n' + planTree(plan));
      console.log();
      console.log(finalBox(res.answer));
      console.log(metricsLine(res.metrics));
      console.log(tokenLine(
        tokenBreakdown(current.history, { systemBase: plannerSystemPrompt(registry) }),
        contextWindow(),
      ));
      console.log(c.dim(`(用 /trace 看完整 span 树；wall-clock=${Date.now() - start}ms)`));
      sessions.save(current);
    } catch (err) {
      spinner.stop();
      console.log(errorLine('v2 agent', (err as Error).message));
    }
    rl.prompt();
  });

  // Ctrl-C 语义：单击清空输入，双击退出；跟 v1 一致（simplified 版本）
  let sigintOnce = false;
  rl.on('SIGINT', () => {
    if (sigintOnce) { console.log(c.gray('\n再见。')); rl.close(); return; }
    sigintOnce = true;
    setTimeout(() => { sigintOnce = false; }, 1500);
    console.log(c.dim('\n(再按一次 Ctrl-C 退出)'));
    rl.prompt();
  });

  rl.on('close', async () => {
    if (mcpManager) await mcpManager.shutdown();
    console.log(c.gray('bye.'));
    process.exit(0);
  });
  rl.prompt();
}

main().catch((err) => {
  console.error(c.red('v2 REPL 崩溃: ' + (err as Error).stack));
  process.exit(1);
});
