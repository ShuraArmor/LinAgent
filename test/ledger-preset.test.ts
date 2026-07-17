import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEmptyLedger, applyPatches,
  pickPreset, mergePresets, loadPresetsFromDir,
  BUILTIN_PRESETS, DEFAULT_PRESET,
} from '../src/ledger/index.ts';
import type { Preset } from '../src/ledger/index.ts';

test('pickPreset: 空账本 + 空输入 → 兜底到 default', () => {
  const l = createEmptyLedger('s1');
  const sel = pickPreset(l, '');
  assert.equal(sel.preset.name, 'default');
});

test('pickPreset: intent 含"报错"关键词 → 命中 debug preset', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: '排查 npm test 报错' }], 1);
  const sel = pickPreset(l, '为什么 test 挂了');
  assert.equal(sel.preset.name, 'debug');
  assert.ok(sel.score > 0);
});

test('pickPreset: intent 含"部署"关键词 → 命中 execution preset', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: '部署项目到 staging' }], 1);
  const sel = pickPreset(l, '帮我部署');
  assert.equal(sel.preset.name, 'execution');
});

test('pickPreset: custom.debug.* 存在 → 强命中 debug preset（+5 分）', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [
    { op: 'add', path: 'custom.debug.causal_chain', value: { text: '因果链' } },
  ], 1);
  // 就算 user 输入完全无关，只要账本已经在用 debug namespace，就该选 debug
  const sel = pickPreset(l, '继续');
  assert.equal(sel.preset.name, 'debug');
  assert.ok(sel.score >= 5);
});

test('pickPreset: 多个关键词命中 → 分数累加', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: '排查为什么 build 报错崩了' }], 1);
  const sel = pickPreset(l, '看看这个 debug 一下');
  assert.equal(sel.preset.name, 'debug');
  // 至少命中 3 个 debug 关键词 (排查/为什么/报错/debug) → score >= 6
  assert.ok(sel.score >= 6, `score = ${sel.score}`);
});

test('pickPreset: 完全不相关的 intent → 保底 default', () => {
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: 'xyz nonsense zzz' }], 1);
  const sel = pickPreset(l, 'foobar');
  assert.equal(sel.preset.name, 'default');
});

test('mergePresets: 用户 preset 与内置合并，同名覆盖', () => {
  const userDebug: Preset = {
    name: 'debug',
    description: '用户版 debug preset',
    intent_keywords: ['我的关键词'],
    example: DEFAULT_PRESET.example,
  };
  const merged = mergePresets([userDebug]);
  // 用户版 debug 覆盖内置 debug
  const debugList = merged.filter((p) => p.name === 'debug');
  assert.equal(debugList.length, 1);
  assert.equal(debugList[0].description, '用户版 debug preset');
  // 其它内置 preset 保留
  assert.ok(merged.some((p) => p.name === 'execution'));
  assert.ok(merged.some((p) => p.name === 'default'));
});

test('mergePresets: 用户 preset 会被 pickPreset 优先命中', () => {
  const customPreset: Preset = {
    name: 'refactor',
    description: '用户自定义重构类会话',
    intent_keywords: ['重构', 'refactor'],
    example: DEFAULT_PRESET.example,
  };
  const merged = mergePresets([customPreset]);
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: '重构一下这段' }], 1);
  const sel = pickPreset(l, '', merged);
  assert.equal(sel.preset.name, 'refactor');
});

test('loadPresetsFromDir: 目录不存在 → 空数组，不 throw', () => {
  const nonExistent = join(tmpdir(), 'linagent-does-not-exist-' + Math.random());
  const presets = loadPresetsFromDir(nonExistent);
  assert.deepEqual(presets, []);
});

test('loadPresetsFromDir: 目录里有合法 preset 就加载', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-preset-'));
  try {
    const p: Preset = {
      name: 'mytest',
      description: '测试用',
      intent_keywords: ['test-marker'],
      example: DEFAULT_PRESET.example,
    };
    writeFileSync(join(dir, 'mytest.json'), JSON.stringify(p), 'utf8');
    // 坏文件也放一个 —— 应该被静默跳过
    writeFileSync(join(dir, 'bad.json'), 'this is not json', 'utf8');
    const loaded = loadPresetsFromDir(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, 'mytest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BUILTIN_PRESETS 都能通过基本合法性检查', () => {
  for (const p of BUILTIN_PRESETS) {
    assert.ok(typeof p.name === 'string' && p.name.length > 0, `preset 缺 name: ${JSON.stringify(p)}`);
    assert.ok(typeof p.description === 'string' && p.description.length > 0, `preset ${p.name} 缺 description`);
    assert.ok(p.example, `preset ${p.name} 缺 example`);
    assert.ok(p.example.core, `preset ${p.name}.example 缺 core`);
    assert.equal(p.example.version, 1);
  }
});

test('pickPreset: mergePresets 覆盖 default 后无命中时用用户版（回归 review 发现的 bug）', () => {
  const userDefault: Preset = {
    name: 'default',
    description: '用户自定义 default',
    intent_keywords: [],
    example: {
      ...DEFAULT_PRESET.example,
      core: { ...DEFAULT_PRESET.example.core, intent: '用户版占位' },
    },
  };
  const merged = mergePresets([userDefault]);
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: 'xyz nonsense' }], 1);
  const sel = pickPreset(l, 'foobar', merged);
  assert.equal(sel.preset.name, 'default');
  // 关键：拿到的是用户版，不是内置版
  assert.equal(sel.preset.description, '用户自定义 default');
  assert.equal(sel.preset.example.core.intent, '用户版占位');
});

test('pickPreset: 非字符串 intent_keywords 不 crash（fail-safe）', () => {
  const bad: Preset = {
    name: 'bad',
    description: '故意坏的 preset',
    // 塞不合法类型模拟从磁盘加载没规范化的场景
    intent_keywords: [42 as unknown as string, null as unknown as string, '', 'good'],
    example: DEFAULT_PRESET.example,
  };
  const l = createEmptyLedger('s1');
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: 'good keyword here' }], 1);
  // 不该抛 —— 会 skip 掉非字符串项，只匹配 'good'
  const sel = pickPreset(l, '', [bad, DEFAULT_PRESET]);
  assert.equal(sel.preset.name, 'bad');
  assert.ok(sel.score >= 2);
});

test('loadPresetsFromDir: 规范化非字符串 intent_keywords', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-preset-'));
  try {
    // 磁盘里放一份坏格式 preset
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({
      name: 'bad',
      description: 'bad kws',
      intent_keywords: ['ok', 42, null, ''],   // 混合类型
      custom_namespaces: ['debug', 999, ''],
      example: DEFAULT_PRESET.example,
    }), 'utf8');
    const loaded = loadPresetsFromDir(dir);
    assert.equal(loaded.length, 1);
    // 非字符串被过滤，只剩 'ok'
    assert.deepEqual(loaded[0].intent_keywords, ['ok']);
    assert.deepEqual(loaded[0].custom_namespaces, ['debug']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPresetsFromDir: 拒绝缺 example.core 的 preset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-preset-'));
  try {
    writeFileSync(join(dir, 'incomplete.json'), JSON.stringify({
      name: 'x',
      example: {},   // 没有 core
    }), 'utf8');
    const loaded = loadPresetsFromDir(dir);
    assert.equal(loaded.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadPresetsFromDir: 拒绝空 name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-preset-'));
  try {
    writeFileSync(join(dir, 'empty-name.json'), JSON.stringify({
      name: '',
      example: DEFAULT_PRESET.example,
    }), 'utf8');
    const loaded = loadPresetsFromDir(dir);
    assert.equal(loaded.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
