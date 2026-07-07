import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFile, SkillRegistry } from '../src/skills.ts';
import { loadSkillTool } from '../src/tools/skill.ts';
import type { SkillHandle, Tool } from '../src/types.ts';

async function call(t: Tool, args: Record<string, unknown>, skills?: SkillHandle): Promise<unknown> {
  return await Promise.resolve(t.handler(args, { sessionId: 't', sessionState: {}, logger: () => {}, skills }));
}

test('parseSkillFile: 拆出 frontmatter 与正文', () => {
  const raw = `---
name: foo
description: 一个测试 skill
---
这是正文
第二行`;
  const r = parseSkillFile(raw);
  assert.equal(r.name, 'foo');
  assert.equal(r.description, '一个测试 skill');
  assert.equal(r.body, '这是正文\n第二行');
});

test('parseSkillFile: 去掉描述里的引号', () => {
  const raw = `---
name: "bar"
description: '带引号的描述'
---
body`;
  const r = parseSkillFile(raw);
  assert.equal(r.name, 'bar');
  assert.equal(r.description, '带引号的描述');
});

test('parseSkillFile: 没有 frontmatter 时整个当正文', () => {
  const r = parseSkillFile('just body text');
  assert.equal(r.name, undefined);
  assert.equal(r.body, 'just body text');
});

function mkSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-skills-'));
  const s1 = join(dir, 'alpha');
  mkdirSync(s1);
  writeFileSync(join(s1, 'SKILL.md'), `---\nname: alpha\ndescription: 第一个 skill\n---\nAlpha 的完整指令`, 'utf8');
  const s2 = join(dir, 'beta');
  mkdirSync(s2);
  writeFileSync(join(s2, 'SKILL.md'), `---\nname: beta\ndescription: 第二个 skill\n---\nBeta 的完整指令`, 'utf8');
  // 一个没有 description 的，应被跳过
  const s3 = join(dir, 'nodesc');
  mkdirSync(s3);
  writeFileSync(join(s3, 'SKILL.md'), `---\nname: nodesc\n---\n没有描述`, 'utf8');
  return dir;
}

test('SkillRegistry: 扫描目录收集 skill 元信息', () => {
  const dir = mkSkillsDir();
  try {
    const reg = new SkillRegistry(dir);
    const names = reg.list().map((s) => s.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);  // nodesc 被跳过
    assert.ok(reg.has('alpha'));
    assert.ok(!reg.has('nodesc'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SkillRegistry: load 读完整正文', () => {
  const dir = mkSkillsDir();
  try {
    const reg = new SkillRegistry(dir);
    const s = reg.load('alpha');
    assert.equal(s.body, 'Alpha 的完整指令');
    assert.equal(s.description, '第一个 skill');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SkillRegistry: describeForPrompt 只含 name + description', () => {
  const dir = mkSkillsDir();
  try {
    const reg = new SkillRegistry(dir);
    const desc = reg.describeForPrompt();
    assert.match(desc, /alpha: 第一个 skill/);
    assert.match(desc, /beta: 第二个 skill/);
    assert.doesNotMatch(desc, /完整指令/);  // 正文不该出现在清单里
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SkillRegistry: 不存在的目录 → 空注册表，但提示可创建', () => {
  const reg = new SkillRegistry('/nonexistent/path/xyz');
  assert.equal(reg.list().length, 0);
  assert.match(reg.describeForPrompt(), /create_skill/);
});

test('load_skill 工具: 加载已知 skill', async () => {
  const dir = mkSkillsDir();
  try {
    const reg = new SkillRegistry(dir);
    const handle: SkillHandle = {
      load: (n) => { const s = reg.load(n); return { name: s.name, description: s.description, body: s.body }; },
      names: () => reg.list().map((s) => s.name),
      list: () => reg.list().map((s) => ({ name: s.name, description: s.description })),
      create: (name, desc, body) => reg.create(name, desc, body),
    };
    const out = await call(loadSkillTool, { name: 'alpha' }, handle) as {
      ok: boolean; instructions: string;
    };
    assert.equal(out.ok, true);
    assert.equal(out.instructions, 'Alpha 的完整指令');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load_skill 工具: 未知 skill 返回 ok:false + 可用列表', async () => {
  const dir = mkSkillsDir();
  try {
    const reg = new SkillRegistry(dir);
    const handle: SkillHandle = {
      load: (n) => { const s = reg.load(n); return { name: s.name, description: s.description, body: s.body }; },
      names: () => reg.list().map((s) => s.name),
      list: () => reg.list().map((s) => ({ name: s.name, description: s.description })),
      create: (name, desc, body) => reg.create(name, desc, body),
    };
    const out = await call(loadSkillTool, { name: '不存在' }, handle) as { ok: boolean; error: string };
    assert.equal(out.ok, false);
    assert.match(out.error, /alpha/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load_skill 工具: 没配 skill 注册表时抛错', async () => {
  await assert.rejects(() => call(loadSkillTool, { name: 'x' }), /没有配置 skill/);
});
