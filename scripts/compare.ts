/**
 * 用同一个真实 LLM，让 v1（循环）和 v2（planner/executor 分离）跑同一个请求，
 * 打印 LLM 调用次数、wall-clock、trace 长度，方便对比。
 *
 *   npx tsx scripts/compare.ts "帮我查一下北京的天气，然后把'带伞'加进待办"
 */
import { loadDotEnv } from '../src/util/dotenv.ts';
import { buildLLMFromEnv } from '../src/llm/client.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { Agent as V1Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { V2Agent } from '../src/v2/agent.ts';

async function main() {
  loadDotEnv();
  const llm = buildLLMFromEnv();
  const reg = buildDefaultRegistry();
  const userMsg = process.argv.slice(2).join(' ') ||
    "帮我查一下北京的天气，然后把'带伞'加进待办";

  console.log(`\n=== 用户请求 ===\n${userMsg}\n`);

  // v1：包一下 .chat 好统计调用次数
  let v1Calls = 0;
  const v1Llm = {
    name: llm.name,
    chat: async (msgs: Parameters<typeof llm.chat>[0], opts?: Parameters<typeof llm.chat>[1]) => {
      v1Calls++;
      return llm.chat(msgs, opts);
    },
  };
  const v1Mgr = new SessionManager();
  const v1Session = v1Mgr.create('v1');
  const v1Agent = new V1Agent(v1Llm as typeof llm, reg, { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false });
  const t1 = Date.now();
  const v1Res = await v1Agent.chat(v1Session, userMsg);
  const v1Elapsed = Date.now() - t1;

  // v2：指标是内建的
  const v2Mgr = new SessionManager();
  const v2Session = v2Mgr.create('v2');
  const v2Agent = new V2Agent(llm, reg);
  const t2 = Date.now();
  const v2Res = await v2Agent.chat(v2Session, userMsg);
  const v2Elapsed = Date.now() - t2;

  console.log(`─── v1（while 循环） ─────────────────────────────`);
  console.log(`回答:        ${v1Res.finalAnswer}`);
  console.log(`LLM 调用:    ${v1Calls}`);
  console.log(`轮次:        ${v1Res.turns}`);
  console.log(`trace 步数:  ${v1Res.trace.length}`);
  console.log(`耗时:        ${v1Elapsed}ms`);
  console.log();
  console.log(`─── v2（planner/executor） ───────────────────────`);
  console.log(`回答:            ${v2Res.answer}`);
  console.log(`LLM 调用:        ${v2Res.metrics.llm_calls}`);
  console.log(`  planner:       ${v2Res.metrics.planner_calls}`);
  console.log(`  reflector:     ${v2Res.metrics.reflector_calls}`);
  console.log(`  synthesize:    ${v2Res.metrics.synth_calls}`);
  console.log(`span 数:         ${v2Res.spans.length}`);
  console.log(`耗时:            ${v2Elapsed}ms`);
  console.log();
  console.log(`─── 差值 ─────────────────────────────────────`);
  console.log(`LLM 调用:  v1=${v1Calls}  v2=${v2Res.metrics.llm_calls}  ` +
    `(减少 ${v1Calls > 0 ? Math.round(((v1Calls - v2Res.metrics.llm_calls) / v1Calls) * 100) : 0}%)`);
  console.log(`Wall-clock: v1=${v1Elapsed}ms  v2=${v2Elapsed}ms`);
}

main().catch((err) => {
  console.error('对比脚本失败:', err?.message ?? err);
  if (err?.body) console.error('响应体:', String(err.body).slice(0, 400));
  process.exit(1);
});
