/**
 * 用同一个真实 LLM、同一个 Agent，分别在 loop 模式和 plan 模式下跑同一请求，
 * 打印 LLM 调用次数、wall-clock、trace 长度，方便对比两种决策模式的开销。
 *
 * 只有一个 Agent + planMode 开关：loop 模式（边想边做）vs plan 模式（先规划再执行）。
 *
 *   npx tsx scripts/compare.ts "帮我查一下北京的天气，然后把'带伞'加进待办"
 */
import { loadDotEnv } from '../src/util/dotenv.ts';
import { buildLLMFromEnv } from '../src/llm/client.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import type { LLMClient } from '../src/types.ts';

/** 包一层，统计 chat（loop 决策）+ complete（planner/synth）两条路径的调用总数。 */
function counting(llm: LLMClient): { llm: LLMClient; count: () => number } {
  let n = 0;
  const wrapped: LLMClient = {
    name: llm.name,
    chat: (req) => { n++; return llm.chat(req); },
    complete: llm.complete ? (msgs, opts) => { n++; return llm.complete!(msgs, opts); } : undefined,
  };
  return { llm: wrapped, count: () => n };
}

async function run(mode: 'loop' | 'plan', base: LLMClient, userMsg: string) {
  const { llm, count } = counting(base);
  const reg = buildDefaultRegistry();
  const session = new SessionManager().create(mode);
  if (mode === 'plan') session.state.planMode = true;
  const agent = new Agent(llm, reg, { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false });
  const t = Date.now();
  const res = await agent.chat(session, userMsg);
  return { res, calls: count(), elapsed: Date.now() - t };
}

async function main() {
  loadDotEnv();
  const base = buildLLMFromEnv();
  const userMsg = process.argv.slice(2).join(' ') ||
    "帮我查一下北京的天气，然后把'带伞'加进待办";

  console.log(`\n=== 用户请求 ===\n${userMsg}\n`);

  const loop = await run('loop', base, userMsg);
  const plan = await run('plan', base, userMsg);

  console.log(`─── loop 模式（ReAct 边想边做） ──────────────────`);
  console.log(`回答:        ${loop.res.finalAnswer}`);
  console.log(`LLM 调用:    ${loop.calls}`);
  console.log(`轮次:        ${loop.res.turns}`);
  console.log(`trace 步数:  ${loop.res.trace.length}`);
  console.log(`耗时:        ${loop.elapsed}ms`);
  console.log();
  console.log(`─── plan 模式（先规划再执行） ────────────────────`);
  console.log(`回答:            ${plan.res.finalAnswer}`);
  console.log(`LLM 调用:        ${plan.calls}`);
  if (plan.res.planMetrics) {
    console.log(`  planner:       ${plan.res.planMetrics.planner_calls}`);
    console.log(`  reflector:     ${plan.res.planMetrics.reflector_calls}`);
  }
  console.log(`span 数:         ${plan.res.spans?.length ?? 0}`);
  console.log(`耗时:            ${plan.elapsed}ms`);
  console.log();
  console.log(`─── 差值 ─────────────────────────────────────`);
  const pct = loop.calls > 0 ? Math.round(((loop.calls - plan.calls) / loop.calls) * 100) : 0;
  console.log(`LLM 调用:  loop=${loop.calls}  plan=${plan.calls}  (plan 相对 ${pct >= 0 ? '减少' : '增加'} ${Math.abs(pct)}%)`);
  console.log(`Wall-clock: loop=${loop.elapsed}ms  plan=${plan.elapsed}ms`);
}

main().catch((err) => {
  console.error('对比脚本失败:', err?.message ?? err);
  if (err?.body) console.error('响应体:', String(err.body).slice(0, 400));
  process.exit(1);
});
