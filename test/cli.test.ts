import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram, toConfig } from '../src/cli.ts';
import { buildLLMFromEnv } from '../src/llm/client.ts';

// CLI 解析：旗标 > env > 默认。parse 用 commander 的 from:'user'（只给旗标，不含 node/script）。
function parse(args: string[]) {
  const program = buildProgram('9.9.9');
  program.parse(args, { from: 'user' });
  return toConfig(program.opts());
}

test('CLI: 默认值（无旗标）', () => {
  const cfg = parse([]);
  assert.equal(cfg.plan, false, '默认 loop 模式');
  assert.equal(cfg.stream, true, '默认开流式');
  assert.equal(cfg.maxTurns, undefined);
  assert.equal(cfg.llm.provider, undefined, '未传则不覆盖，交给 env/preset');
});

test('CLI: --plan 开启 plan 模式', () => {
  assert.equal(parse(['--plan']).plan, true);
});

test('CLI: --no-stream 关闭流式', () => {
  assert.equal(parse(['--no-stream']).stream, false);
});

test('CLI: provider/model/api-key 旗标进 llm overrides', () => {
  const cfg = parse(['--provider', 'deepseek', '--model', 'deepseek-chat', '--api-key', 'sk-xxx']);
  assert.equal(cfg.llm.provider, 'deepseek');
  assert.equal(cfg.llm.model, 'deepseek-chat');
  assert.equal(cfg.llm.apiKey, 'sk-xxx');
});

test('CLI: 数值旗标解析为整数', () => {
  const cfg = parse(['--max-turns', '10', '--context-max', '50', '--timeout', '30000']);
  assert.equal(cfg.maxTurns, 10);
  assert.equal(cfg.contextMax, 50);
  assert.equal(cfg.llm.timeoutMs, 30000);
});

test('CLI: 非法数值旗标抛错', () => {
  assert.throws(() => parse(['--max-turns', 'abc']));
  assert.throws(() => parse(['--max-turns', '-5']));
});

test('CLI: home/user 旗标透传', () => {
  const cfg = parse(['--home', '/tmp/lin', '--user', 'alice']);
  assert.equal(cfg.home, '/tmp/lin');
  assert.equal(cfg.user, 'alice');
});

// ── 优先级：overrides > env > preset ──
// name 只是协议名（'openai'/'anthropic'），model 是 private，所以这里验证
// provider 路由（overrides.provider 覆盖 env）+ 构造不抛错。
test('buildLLM: --provider 旗标覆盖 env（走 anthropic 协议）', () => {
  const env = { LLM_PROVIDER: 'openai', LLM_API_KEY: 'env-key' } as NodeJS.ProcessEnv;
  const llm = buildLLMFromEnv(env, { provider: 'anthropic', apiKey: 'flag-key' });
  assert.equal(llm.name, 'anthropic', 'provider 用旗标值 → anthropic 协议');
});

test('buildLLM: 无 provider 旗标时回落到 env', () => {
  const env = { LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'env-key' } as NodeJS.ProcessEnv;
  const llm = buildLLMFromEnv(env, {});
  assert.equal(llm.name, 'anthropic', 'provider 用 env 值');
});

test('buildLLM: --api-key 覆盖 env 后不抛错', () => {
  const env = {} as NodeJS.ProcessEnv; // env 无 key
  assert.doesNotThrow(() => buildLLMFromEnv(env, { provider: 'openai', apiKey: 'flag-key' }));
});

test('buildLLM: 缺 API key 抛错', () => {
  const env = { LLM_PROVIDER: 'openai' } as NodeJS.ProcessEnv;
  assert.throws(() => buildLLMFromEnv(env, {}), /API key/);
});

test('buildLLM: 未知 provider 抛错', () => {
  assert.throws(() => buildLLMFromEnv({} as NodeJS.ProcessEnv, { provider: 'nope', apiKey: 'x' }), /Unknown provider/);
});
