/**
 * 命令行解析层 —— 用 commander 把旗标标准化。
 *
 * 优先级：CLI 旗标 > 环境变量 > preset/内置默认。
 * cli.ts 只负责解析并产出一个 CliConfig；真正的装配在 index.ts::main(config)。
 *
 * 设计原则：解析与副作用分离。这里除了 `--home` 需要在 storage 读缓存前落到
 * env(见 applyEarlyEnv),其余一律只读、不碰全局状态。
 */
import { Command, Option } from 'commander';
import type { LLMOverrides } from './llm/client.ts';

export interface CliConfig {
  llm: LLMOverrides;
  /** 开局是否进 plan 模式（新会话的 state.planMode 初值）。 */
  plan: boolean;
  /** 是否实时显示流式输出。默认 true；--no-stream 关闭。 */
  stream: boolean;
  /** agent 最大轮次（loop 模式）。undefined = 用内置默认。 */
  maxTurns?: number;
  /** 上下文压缩的 maxMessages 阈值。undefined = 用内置默认。 */
  contextMax?: number;
  /** 记忆用户 id。undefined = 用 LINAGENT_USER 或 'default'。 */
  user?: string;
  /** 存储根目录（等价 LINAGENT_HOME）。main() 会在读 storage 缓存前落到 env。 */
  home?: string;
}

/** 把字符串解析成正整数，非法则报错退出（commander 会捕获）。 */
function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} 必须是正整数，收到 "${value}"`);
  }
  return n;
}

/**
 * 构造 commander program。抽成函数便于测试（测试传自己的 argv）。
 * 不在这里 parse —— 由调用方决定 parse 时机与 argv 来源。
 */
export function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name('linagent')
    .description('LinAgent —— 从零构建的最小可用 Agent 运行时（无框架）。\n一个 ReAct agent，plan 只是它的一个可切换模式（--plan 或 REPL 内 /plan）。')
    .version(version, '-v, --version', '打印版本号')
    .helpOption('-h, --help', '打印帮助')
    // ── LLM ──
    .addOption(new Option('--provider <name>', 'LLM provider preset（openai/anthropic/deepseek/moonshot/dashscope/zhipu/openrouter/groq/ollama）'))
    .addOption(new Option('--model <id>', '覆盖 preset 默认模型'))
    .addOption(new Option('--api-key <key>', 'API key（也可用 LLM_API_KEY 或 provider 惯用变量）'))
    .addOption(new Option('--base-url <url>', '覆盖 preset baseUrl（如公司代理）'))
    .addOption(new Option('--timeout <ms>', 'LLM 请求超时（毫秒）').argParser((v) => parsePositiveInt(v, '--timeout')))
    // ── 模式 / runtime ──
    .addOption(new Option('--plan', '开局进 plan 模式（先规划再执行）。默认 loop（边想边做）').default(false))
    .addOption(new Option('--no-stream', '关闭流式实时显示（等价 LINAGENT_NOSTREAM=1）'))
    .addOption(new Option('--max-turns <n>', 'loop 模式最大轮次').argParser((v) => parsePositiveInt(v, '--max-turns')))
    .addOption(new Option('--context-max <n>', '上下文压缩触发的消息数阈值').argParser((v) => parsePositiveInt(v, '--context-max')))
    // ── 存储 / 身份 ──
    .addOption(new Option('--home <dir>', 'LinAgent 存储根目录（等价 LINAGENT_HOME）'))
    .addOption(new Option('--user <id>', '记忆用户 id（等价 LINAGENT_USER）'));
  return program;
}

/** 从已解析的 commander opts 产出 CliConfig（纯函数，便于测试）。 */
export function toConfig(opts: Record<string, unknown>): CliConfig {
  return {
    llm: {
      provider: opts.provider as string | undefined,
      model: opts.model as string | undefined,
      apiKey: opts.apiKey as string | undefined,
      baseUrl: opts.baseUrl as string | undefined,
      timeoutMs: opts.timeout as number | undefined,
    },
    plan: Boolean(opts.plan),
    // commander 的 --no-stream：未传时 opts.stream 为 true，传了为 false。
    stream: opts.stream !== false,
    maxTurns: opts.maxTurns as number | undefined,
    contextMax: opts.contextMax as number | undefined,
    user: opts.user as string | undefined,
    home: opts.home as string | undefined,
  };
}

/**
 * `--home` 必须在 storage.ts 的 linagentHome() 首次调用（会 memo 缓存）之前落到
 * env，否则覆盖无效。main() 在 import storage 后、调 linagentHome 前调用它。
 */
export function applyEarlyEnv(config: { home?: string }): void {
  if (config.home && config.home.trim()) {
    process.env.LINAGENT_HOME = config.home;
  }
}

/** 解析 process.argv，产出 CliConfig。--home 已在此落 env。 */
export function parseCli(argv: string[], version: string): CliConfig {
  const program = buildProgram(version);
  program.parse(argv);
  const opts = program.opts();
  applyEarlyEnv({ home: opts.home as string | undefined });
  return toConfig(opts);
}
