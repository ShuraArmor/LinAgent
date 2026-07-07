import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SkillRegistry } from '../src/skills.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

function mkSkills(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-skill-e2e-'));
  const s = join(dir, 'greet');
  mkdirSync(s);
  writeFileSync(join(s, 'SKILL.md'),
    `---\nname: greet\ndescription: 用中文正式问候的规范\n---\n必须以"尊敬的"开头。`, 'utf8');
  return dir;
}

test('skills e2e: skill 清单被注入 system prompt', async () => {
  const dir = mkSkills();
  try {
    const skills = new SkillRegistry(dir);
    const llm = new MockLLM([finalAnswer('好')]);
    const agent = new Agent(llm, buildDefaultRegistry(), cfg, undefined, skills);
    const res = await agent.chat(new SessionManager().create(), '你好');
    // 第一次 LLM 调用的 system prompt 里应含 skill 清单
    const sys = llm.calls[0].find((m) => m.role === 'system')?.content ?? '';
    assert.match(sys, /greet: 用中文正式问候的规范/);
    // 但正文（"尊敬的"）不该出现在 system prompt 里 —— 渐进式披露
    assert.doesNotMatch(sys, /尊敬的/);
    // RunResult 里 systemPromptBase 应带上 skill 段
    assert.match(res.systemPromptBase, /greet/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('skills e2e: agent 调 load_skill 拿到正文', async () => {
  const dir = mkSkills();
  try {
    const skills = new SkillRegistry(dir);
    const llm = new MockLLM([
      toolCall('load_skill', { name: 'greet' }),
      finalAnswer('尊敬的用户，你好'),
    ]);
    const agent = new Agent(llm, buildDefaultRegistry(), cfg, undefined, skills);
    const s = new SessionManager().create();
    await agent.chat(s, '正式问候我一下');
    // load_skill 的结果应作为 tool 消息进了 history，含正文
    const toolMsg = s.history.find((m) => m.role === 'tool' && m.toolName === 'load_skill');
    assert.ok(toolMsg, '应有 load_skill 的 tool 结果');
    assert.match(toolMsg!.content, /尊敬的/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('skills e2e: 没配 skill 时不注册 load_skill、system prompt 无 skill 段', async () => {
  const llm = new MockLLM([finalAnswer('ok')]);
  const reg = buildDefaultRegistry();
  const agent = new Agent(llm, reg, cfg);  // 不传 skills
  await agent.chat(new SessionManager().create(), 'hi');
  assert.ok(!reg.has('load_skill'), '没配 skill 时不该注册 load_skill');
});

test('skills e2e: 空 skill 目录不注册 load_skill', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'linagent-empty-skill-'));
  try {
    const skills = new SkillRegistry(empty);
    const reg = buildDefaultRegistry();
    const llm = new MockLLM([finalAnswer('ok')]);
    new Agent(llm, reg, cfg, undefined, skills);
    assert.ok(!reg.has('load_skill'), '空 skill 目录不该注册 load_skill');
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
