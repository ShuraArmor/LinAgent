import * as readline from 'node:readline';
import { linagentHome, sessionsDir, memoryDir } from './storage.ts';
import { Agent, DEFAULT_AGENT_CONFIG } from './agent.ts';
import { SessionManager, FileSessionStore } from './session.ts';
import { buildDefaultRegistry } from './tools/index.ts';
import { buildLLMFromEnv } from './llm/client.ts';
import { loadDotEnv } from './util/dotenv.ts';
import { FileMemoryStore, retrieveForQuery, formatForPrompt } from './memory.ts';
import { c, hr, symbols } from './ui/ansi.ts';
import {
  banner, userLine, thoughtLine,
  toolCallLine, toolResultLine, finalBox, errorLine,
  compressLine, statusLine, traceDump, sessionRow,
} from './ui/render.ts';
import { Spinner } from './ui/spinner.ts';
import { truncateCols } from './ui/width.ts';
import { parseAgentOutput } from './llm/parser.ts';
import { setSandboxRoot } from './tools/fs.ts';
import { RISKY_TOOLS } from './tools/index.ts';
import { select } from './ui/prompt.ts';
import type { ApprovalDecision, ApprovalRequest } from './agent.ts';
import { breakdown as tokenBreakdown, contextWindow } from './tokens.ts';
import { tokenLine, tokenBarChart } from './ui/tokens.ts';
import { buildSystemPrompt } from './llm/prompt.ts';

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
  const store = new FileSessionStore(sessionsDir());
  const sessions = new SessionManager(store);

  // 打印 banner + 存储位置提示
  console.log(banner(llm.name, registry.list().map((t) => t.name)));
  const home = linagentHome();
  const sourceLabel: Record<'env' | 'cwd' | 'os', string> = {
    env: 'LINAGENT_HOME',
    cwd: '项目本地 .linagent/',
    os:  '系统缓存目录',
  };
  console.log(c.gray(`存储: ${c.underline(home.path)}  ${c.dim(`(${sourceLabel[home.source]})`)}`));
  if (sessions.list().length > 0) {
    console.log(c.gray(`已恢复 ${sessions.list().length} 个会话`));
  }

  let current = sessions.list()[0] ?? sessions.create('window-1');
  console.log(c.gray(`当前会话: ${c.cyan(current.id)} (${current.title})`));
  console.log(c.dim(`命令: /new [标题] · /list · /switch <id> · /rm <id> · /memory [list|forget <id>|clear] · /tokens · /trace · /reset · /nostream · /help · /exit`));
  console.log(hr(), '\n');

  // 跨会话记忆 —— <LinAgent home>/memory/ 下每个用户一个文件
  const memStore = new FileMemoryStore(memoryDir());
  const userId = process.env.LINAGENT_USER ?? 'default';
  console.log(c.gray(`Memory: 用户=${c.cyan(userId)}`));

  // 沙盒默认关闭：fs_* 工具可访问整个文件系统。
  // fs_write / fs_delete 依然会走审批门，每次都要用户明确同意。
  // 若要限制作用域，取消下一行注释：
  // setSandboxRoot(process.cwd());
  void setSandboxRoot;

  // 一根永不熄的心跳，保证进程始终有活跃 handle。
  // 即使 stdin / readline 因为 raw-mode 切换出现瞬时空档，事件循环也不会
  // 判定"没事干"而退出。unref() 让它自己不阻塞真正的正常退出。
  const heartbeat = setInterval(() => { /* keepalive */ }, 60_000);
  heartbeat.unref();
  // Windows 下 unref 后 event loop 仍可能因 stdin 断开而退出 —— 兜底 ref 一下：
  const keepAlive = setInterval(() => { /* keepalive-hard */ }, 3600_000);

  // 审批门：REPL 里用 raw-mode 交互式选择器
  const approve = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    // 暂停 readline 以便原生读取 stdin
    rl.pause();
    try {
      const argsPreview = JSON.stringify(req.args, null, 2);
      const detail = [
        `轮次: ${req.turn}    会话: ${req.sessionId}`,
        `工具: ${req.toolName}`,
        `参数:`,
        ...argsPreview.split('\n').map((l) => '  ' + l),
      ];
      const choice = await select<ApprovalDecision>({
        title: `⚠  Agent 想调用高影响工具：${req.toolName}`,
        detail,
        options: [
          { value: 'approve',         label: '允许一次',     description: '这次调用允许，之后同类调用还会问', hotkey: 'y' },
          { value: 'approve_session', label: '本会话都允许', description: '当前 session 内该工具直接放行',   hotkey: 'a' },
          { value: 'deny',            label: '拒绝',         description: '把"用户拒绝"当结果回喂给 LLM',     hotkey: 'n' },
        ],
      });
      return choice ?? 'deny';
    } finally {
      rl.resume();
    }
  };

  const agent = new Agent(llm, registry, {
    ...DEFAULT_AGENT_CONFIG,
    requireApproval: new Set(RISKY_TOOLS),
    approve,
  }, {
    store: memStore,
    userId,
  });

  // 每轮的流式渲染
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // 我们自己接管 SIGINT / close，避免默认行为直接干掉进程。
    terminal: true,
  });
  const prompt = () => rl.setPrompt(`${c.bgBlue(c.bold(` ${current.title} `))} ${c.cyan(symbols.arrow)} `);
  prompt();

  // 记住上一轮真正发给 LLM 的 system / memory 段 —— /tokens 命令要用它才能算准
  // （系统 prompt 每轮临时拼、不写进 history）。
  let lastExtras: { systemBase?: string; memory?: string } = {};

  // Ctrl-C：第一次 → 清空当前输入行；连按两次 → 退出。
  // 这样一来即使 agent 循环里 raw-mode 出了状况，"意外退出"也不会再发生。
  let sigintPending = false;
  process.on('SIGINT', () => {
    if (sigintPending) {
      console.log(c.gray('\n(再见)'));
      rl.close();
      return;
    }
    sigintPending = true;
    setTimeout(() => { sigintPending = false; }, 1500);
    console.log(c.gray('\n(再按一次 Ctrl-C 退出，或输入 /exit)'));
    rl.prompt();
  });

  // 是否实时显示流式（loop 内部仍走流式 API，这里只切换显示）。
  let showStream = process.env.LINAGENT_NOSTREAM !== '1';

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'exit':
        case 'quit':
          rl.close();
          return;
        case 'help':
          console.log(c.gray('命令: /new [标题] · /list · /switch <id> · /rm <id> · /memory [list|forget <id>|clear] · /tokens · /trace · /reset · /nostream · /exit'));
          break;
        case 'new': {
          current = sessions.create(rest.join(' ') || undefined);
          console.log(c.green(`${symbols.check} 已创建并切换到 ${c.cyan(current.id)} ${c.dim(`(${current.title})`)}`));
          prompt();
          break;
        }
        case 'list': {
          const all = sessions.list();
          if (!all.length) { console.log(c.gray('(暂无会话)')); break; }
          for (const s of all) {
            const todos = (s.state.todos as { items?: unknown[] } | undefined)?.items?.length ?? 0;
            console.log(sessionRow(s.id, s.title, s.history.length, todos, s.id === current.id));
          }
          console.log(c.dim(`\n${sessions.location}`));
          break;
        }
        case 'switch': {
          const id = rest[0];
          const target = id ? sessions.get(id) : undefined;
          if (!target) console.log(c.red(`没有此会话: ${id}`));
          else {
            current = target;
            console.log(c.green(`${symbols.check} 已切换到 ${c.cyan(current.id)} (${current.title})`));
            prompt();
          }
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
        case 'trace':
          console.log(traceDump(current.trace));
          break;
        case 'reset':
          current.history = [];
          current.state = {};
          current.trace = [];
          sessions.save(current);
          console.log(c.green(`${symbols.check} 会话已重置`));
          break;
        case 'nostream':
          showStream = !showStream;
          console.log(c.gray(`流式显示: ${showStream ? c.green('开') : c.red('关')}`));
          break;
        case 'memory':
        case 'mem': {
          const sub = rest[0];
          const mem = memStore.load(userId);
          const alive = mem.facts.filter((f) => !f.superseded_by);
          if (!sub || sub === 'list') {
            if (!alive.length) { console.log(c.gray('(暂无记忆)')); break; }
            for (const layer of ['identity', 'preferences', 'facts', 'ongoing'] as const) {
              const items = alive.filter((f) => f.layer === layer);
              if (!items.length) continue;
              console.log(c.cyan(c.bold(layer + ':')));
              for (const f of items) {
                console.log(`  ${c.gray(f.id)}  ${f.text}  ${c.dim(`(${f.confidence.toFixed(2)})`)}`);
              }
            }
          } else if (sub === 'forget') {
            const id = rest[1];
            if (!id) { console.log(c.red('用法: /memory forget <id>')); break; }
            const target = mem.facts.find((f) => f.id === id && !f.superseded_by);
            if (!target) { console.log(c.red(`没有活跃的 fact: ${id}`)); break; }
            target.superseded_by = '__forgotten__';
            memStore.save(mem);
            console.log(c.green(`${symbols.check} 已忘记 ${id}: ${target.text}`));
          } else if (sub === 'clear') {
            for (const f of alive) f.superseded_by = '__forgotten__';
            memStore.save(mem);
            console.log(c.green(`${symbols.check} 已清空 ${alive.length} 条记忆`));
          } else {
            console.log(c.red('用法: /memory [list|forget <id>|clear]'));
          }
          break;
        }
        case 'tokens':
        case 'token': {
          // system / memory 每轮临时拼、不写进 history —— 直接算 history 会漏。
          // 若 lastExtras 不空（已 chat 过一次），用上一轮真发出去的值；否则当场重建：
          //   systemBase → buildSystemPrompt(registry)
          //   memory     → retrieveForQuery(...) + formatForPrompt(...)，query 用最后一条
          //                用户消息（贴近"下次真会带上什么"），没有就用空串（只会命中
          //                identity / preferences 永远注入的层）。
          let extras = lastExtras;
          if (!extras.systemBase) {
            const lastUserMsg = [...current.history].reverse().find((m) => m.role === 'user')?.content ?? '';
            let memoryPrompt = '';
            const mem = memStore.load(userId);
            const relevant = retrieveForQuery(mem, lastUserMsg);
            memoryPrompt = formatForPrompt(relevant);
            extras = {
              systemBase: buildSystemPrompt(registry),
              memory: memoryPrompt,
            };
          }
          console.log(tokenBarChart(tokenBreakdown(current.history, extras), contextWindow()));
          break;
        }
        default:
          console.log(c.red(`未知命令: /${cmd}`));
      }
      rl.prompt();
      return;
    }

    // ─── run the agent ──────────────────────────────────────────────────
    console.log(userLine(text));
    const start = Date.now();
    const spinner = new Spinner('thinking');
    let currentTurn = 0;
    let streamedChars = 0;

    const onTurnStart = (turn: number) => {
      currentTurn = turn;
      streamedChars = 0;
      if (showStream) {
        // header for this turn's live stream
        spinner.stop();
        process.stdout.write(`\n${c.gray(`  ─ turn ${turn} ${symbols.arrow} raw stream ─`)}\n${c.gray('  ')}`);
      } else {
        spinner.start(`turn ${turn} · streaming from ${llm.name}`);
      }
    };

    const onDelta = (chunk: string) => {
      if (!showStream) return;
      // 排版：每次换行后缩进 2 格，让阅读更舒服。
      const indented = chunk.replace(/\n/g, '\n  ');
      process.stdout.write(c.dim(indented));
      streamedChars += chunk.length;
    };

    // 同时实时渲染 trace 事件（工具调用/结果/压缩）——per-call 通过 hooks.onTrace 挂进 chat()，
    // 不动 DEFAULT_AGENT_CONFIG 单例（那份 config 在构造 Agent 时被 spread 展开成新对象，
    // 事后写它根本传不到 Agent 内部）。
    const liveTrace = (entry: { kind: string; data: unknown; turn: number }) => {
      if (entry.kind === 'llm_response') {
        // 本轮流式结束 —— 解析出决策（thought/tool_call）
        // and pretty-print it, then persist the raw content in the transcript region.
        if (showStream) process.stdout.write('\n');
        spinner.stop();
        try {
          const decision = parseAgentOutput((entry.data as { raw: string }).raw);
          if (decision.thought) console.log(thoughtLine(decision.thought));
          if (decision.action === 'tool_call' && decision.tool) {
            console.log(toolCallLine(decision.tool, entry.turn));
          }
        } catch {
          // ignore, error will be surfaced by 'error' trace entry
        }
      } else if (entry.kind === 'tool_call') {
        // 工具真正执行的这段时间，起一个"运行中"spinner，让用户不至于干瞪着。
        const d = entry.data as { name?: string; args?: unknown; log?: string };
        if (d.name && !('log' in d)) {
          const argsPreview = truncateCols(JSON.stringify(d.args ?? {}), 60);
          spinner.updateAndReset(`执行 ${d.name}(${argsPreview})`);
          spinner.start();
        }
      } else if (entry.kind === 'tool_result') {
        spinner.stop();
        const d = entry.data as { name: string; result: unknown };
        const preview = JSON.stringify(d.result).slice(0, 120);
        console.log(toolResultLine(d.name, true, preview));
      } else if (entry.kind === 'error') {
        spinner.stop();
        const d = entry.data as { where: string; message: string };
        console.log(errorLine(d.where, d.message));
      } else if (entry.kind === 'compress') {
        const d = entry.data as { folded: number; kept: number };
        console.log(compressLine(d.folded, d.kept));
      } else if (entry.kind === 'final') {
        // handled by return of chat()
      }
    };

    try {
      const res = await agent.chat(current, text, { onDelta, onTurnStart, onTrace: liveTrace });
      spinner.stop();
      console.log('\n' + finalBox(res.finalAnswer));
      console.log(statusLine(res.turns, res.trace.length, Date.now() - start));
      // Token 用量指标：一行紧凑摘要，详细分布用 /tokens 看。
      // 把这一轮真正拼给 LLM 的 system / memory 段也算进去（它们不在 history 里）。
      lastExtras = { systemBase: res.systemPromptBase, memory: res.memoryPrompt };
      console.log(tokenLine(tokenBreakdown(current.history, lastExtras), contextWindow()));
      sessions.save(current);
    } catch (err) {
      spinner.stop();
      console.log(errorLine('agent', (err as Error).message));
    } finally {
      void currentTurn; void streamedChars;
    }

    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(keepAlive);
    console.log(c.gray('\n再见。'));
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
