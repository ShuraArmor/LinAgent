import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveForQuery, mergeCandidates, type UserMemory, type Fact } from '../src/memory.ts';

let seq = 0;
function fact(text: string, layer: Fact['layer'] = 'facts'): Fact {
  seq += 1;
  return {
    id: `f${seq}`, layer, text, confidence: 0.8, created_at: 0, last_seen_at: 0,
    source: { session: 's', turn: 0 }, recall_count: 0, tier: layer === 'facts' || layer === 'ongoing' ? 'warm' : 'frozen',
  };
}
function mem(...texts: string[]): UserMemory {
  seq = 0; // 每个 mem 从 f1 开始，避免模块级计数器让 id 跨测试漂移
  return { userId: 'u', facts: texts.map((t) => fact(t)), next_id: texts.length + 1 };
}
const hitIds = (m: UserMemory, q: string) => retrieveForQuery(m, q, 10).map((f) => f.id);

// ── 词干：deploy 家族互相召回 ─────────────────────────────────────
test('M3 词干: deploying 的查询能召回 "deployed staging"', () => {
  const m = mem('deployed staging config yesterday');
  const hits = hitIds(m, 'deploying to staging');
  assert.ok(hits.includes('f1'), '词干应让 deploy 家族互通');
});

test('M3 词干: dependencies ↔ dependency', () => {
  const m = mem('updated the dependency list');
  const hits = hitIds(m, 'check dependencies');
  assert.ok(hits.includes('f1'), 'dependencies/dependency 应经词干命中');
});

// ── 别名：缩写 ↔ 全称 ─────────────────────────────────────────────
test('M3 别名: init 查询命中 initialize', () => {
  const m = mem('initialize the module on boot');
  const hits = hitIds(m, 'init sequence');
  assert.ok(hits.includes('f1'), 'init↔initialize 应经别名命中');
});

test('M3 别名: config 缩写家族互通（cfg / configuration）', () => {
  const m = mem('the configuration file lives in root');
  assert.ok(hitIds(m, 'cfg location').includes('f1'), 'cfg↔configuration');
  assert.ok(hitIds(m, 'config path').includes('f1'), 'config↔configuration');
});

// ── 别名：中英对照 ────────────────────────────────────────────────
test('M3 别名: 中文"配置"命中英文 config', () => {
  const m = mem('config lives in the root folder');
  const hits = hitIds(m, '配置放在哪里');
  assert.ok(hits.includes('f1'), '中文"配置"应经别名短语命中英文 config');
});

test('M3 别名: 中文"依赖"命中英文 dependency', () => {
  const m = mem('a new dependency was added');
  const hits = hitIds(m, '这个依赖是干嘛的');
  assert.ok(hits.includes('f1'), '"依赖"↔dependency');
});

// ── 精度守卫：扩展不引入不相关召回 ────────────────────────────────
test('M3 精度: 无任何共享词/别名/词干 → 不召回', () => {
  const m = mem('the cat likes sunlight');
  const hits = hitIds(m, 'quantum entanglement theory');
  assert.equal(hits.length, 0, '完全不相关不该因扩展被召回');
});

test('M3 精度: 精确匹配仍优先于纯别名匹配', () => {
  const m = mem('use pnpm for this repo', 'use yarn elsewhere');
  const hits = retrieveForQuery(m, 'pnpm install', 10);
  // 两条都因 ~pkgmgr 别名相关，但 pnpm 那条精确命中 pnpm，应排前。
  assert.equal(hits[0].text, 'use pnpm for this repo', '精确命中的应排第一');
});

// ── dedup 不被别名过度合并 ────────────────────────────────────────
test('M3 dedup: 共享一个别名的不同事实不被误当同一条', () => {
  const m = mem('use pnpm as the package manager');
  const before = m.facts.length;
  mergeCandidates(m, [{ layer: 'facts', text: 'the database uses yarn locks somehow' }],
    { session: 's', turn: 1 }, 1000);
  // 两条都带 ~pkgmgr，但文本差异大，Jaccard 远不到 0.85 → 应新增而非合并。
  assert.equal(m.facts.length, before + 1, '仅共享别名不该触发 dedup 合并');
});

// ── 诚实边界：开放域上位词不做（文档化局限）─────────────────────
test('M3 边界: 不做开放域上位词泛化（feline↛cat 不命中，符合预期）', () => {
  const m = mem('the cat sleeps all day');
  const hits = hitIds(m, 'feline behavior');
  assert.equal(hits.length, 0, 'M3 明确不做语义泛化——这是已知边界，非 bug');
});
