import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { buildLLMFromEnv } from '../src/llm/client.ts';
import { loadDotEnv } from '../src/util/dotenv.ts';

async function main() {
  loadDotEnv();
  const llm = buildLLMFromEnv();
  const reg = buildDefaultRegistry();
  const mgr = new SessionManager();
  const s = mgr.create('smoke');
  const agent = new Agent(llm, reg, { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false });

  const prompt = process.argv.slice(2).join(' ') || '用 calculator 算一下 (3+4)*2^3';
  console.log(`>>> 用户: ${prompt}\n`);
  const res = await agent.chat(s, prompt);
  console.log('--- 最终答复 ---');
  console.log(res.finalAnswer);
  console.log(`\n轮次 = ${res.turns}`);
  console.log(`trace = ${res.trace.map((t) => t.kind).join(' → ')}`);
}

main().catch((err) => {
  console.error('smoke 脚本失败:', err?.message ?? err);
  if (err?.body) console.error('响应体:', String(err.body).slice(0, 400));
  process.exit(1);
});
