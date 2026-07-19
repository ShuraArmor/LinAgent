import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyLedger, applyPatches,
  deriveClassFromStructure, classFromShape, emergentClass,
  compressionPolicyFor, disposeOf, featureOf,
} from '../src/ledger/index.ts';
import type { Message } from '../src/types.ts';

// ── 形状涌现：从原语价值组合，而非关键词 ──────────────────────────
test('P1 形状: cause/claim 主导 → causal', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'custom.debug.cause', value: { text: '根因是连接泄漏' } },
    { op: 'add', path: 'custom.debug.cause2', value: { text: '因为没关闭游标' } },
    { op: 'add', path: 'suggested.findings', value: { text: '发现内存持续增长' } },
  ], 1);
  assert.equal(deriveClassFromStructure(l), 'causal');
});

test('P1 形状: step/artifact 主导 → executional', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'suggested.progress',  value: { text: '跑了迁移脚本' } },
    { op: 'add', path: 'suggested.progress',  value: { text: '重启了服务' } },
    { op: 'add', path: 'suggested.artifacts', value: { text: '生成 dist/app.js' } },
  ], 1);
  assert.equal(deriveClassFromStructure(l), 'executional');
});

test('P1 形状: choice/option 主导 → deliberative', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'suggested.decisions', value: { text: '决定用事件溯源' } },
    { op: 'add', path: 'custom.brainstorm.option', value: { text: '备选：CRUD 直存' } },
    { op: 'add', path: 'custom.brainstorm.rejected', value: { text: '否决了共享库方案' } },
  ], 1);
  assert.equal(deriveClassFromStructure(l), 'deliberative');
});

test('P1 形状: 空/稀薄账本 → weak（保守）', () => {
  assert.equal(deriveClassFromStructure(undefined), 'weak');
  const l = createEmptyLedger('s');
  applyPatches(l, [{ op: 'add', path: 'suggested.blockers', value: { text: '等审批' } }], 1);
  assert.equal(deriveClassFromStructure(l), 'weak', 'block 不投票主导轴');
});

// ── 份额判据：治"单条定性" + "混合塌 weak"两头（回归 review #1）──────
test('P1 份额: 单条高 base 原语不足以定性 → weak（不因 choice base 高就判 brainstorm）', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [{ op: 'add', path: 'suggested.decisions', value: { text: '用 A 方案' } }], 1);
  // 单条 choice(0.85) 质量 < MIN_MASS(1.0) → weak，不再一锤定音成 deliberative。
  assert.equal(deriveClassFromStructure(l), 'weak');
});

test('P1 份额: 明显执行会话里混一条 decision → 仍 executional（不塌 weak）', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'suggested.progress',  value: { text: '步骤1' } },
    { op: 'add', path: 'suggested.progress',  value: { text: '步骤2' } },
    { op: 'add', path: 'suggested.decisions', value: { text: '顺手一个小决策' } },
  ], 1);
  // executional 占多数份额 → 结构接管；旧的 1.25× 差值比会误判成 weak。
  assert.equal(deriveClassFromStructure(l), 'executional');
});

test('P1 份额: 三轴纠缠、无一过半 → weak（不过度自信）', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'suggested.findings',  value: { text: '结论1' } },   // causal (claim)
    { op: 'add', path: 'suggested.artifacts', value: { text: '产物1' } },   // executional
    { op: 'add', path: 'suggested.decisions', value: { text: '决策1' } },   // deliberative
  ], 1);
  // 三轴各占约 1/3，最高轴份额 < 0.5 → weak（保守，退回关键词先验）。
  assert.equal(deriveClassFromStructure(l), 'weak');
});

// ── 主线：类型从结构涌现，是真实标签，驱动处置 ────────────────────
test('P1 主线: 结构涌现覆盖关键词 —— intent 像 debug 但装的是执行内容 → execution', () => {
  const l = createEmptyLedger('s');
  l.core.intent = 'debug the deployment';  // 关键词会让 resolveClass 判 debug
  applyPatches(l, [
    { op: 'add', path: 'suggested.progress',  value: { text: '执行部署命令' } },
    { op: 'add', path: 'suggested.artifacts', value: { text: '产出构建包' } },
    { op: 'add', path: 'suggested.progress',  value: { text: '推送镜像' } },
  ], 1);
  // emergentClass 看实际结构（执行），不被 intent 关键词带偏。
  assert.equal(emergentClass(l), 'execution', '结构够明确时应由结构驱动，压过关键词');
});

test('P1 主线: 冷启动退回关键词先验 —— 账本稀薄(weak) 时用 intent 兜底', () => {
  const l = createEmptyLedger('s');
  l.core.intent = 'debug the crash';  // 只有关键词，还没攒够原语
  assert.equal(deriveClassFromStructure(l), 'weak', '稀薄账本结构上是 weak');
  // weak → 退回 resolveClass 关键词先验（debug），而非傻等成 default。
  assert.equal(emergentClass(l), 'debug', 'weak 时应退回关键词先验');
});

test('P1 主线: classFromShape 映射一致', () => {
  assert.equal(classFromShape('causal'), 'debug');
  assert.equal(classFromShape('executional'), 'execution');
  assert.equal(classFromShape('deliberative'), 'brainstorm');
  assert.equal(classFromShape('weak'), 'default');
});

// ── 涌现类别驱动 PROFILES 表 → 处置 ───────────────────────────────
const toolErr: Message = { role: 'tool', content: 'Error: connection refused', toolCallId: 'x' };
const toolOk: Message = { role: 'tool', content: 'ok, 3 rows', toolCallId: 'y' };
const reasoning: Message = { role: 'assistant', content: '我觉得应该这样推理' };
const action: Message = { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run', args: {} }] };
const userMsg: Message = { role: 'user', content: '帮我修一下' };

test('P1 处置: 涌现类别 debug → tool_error/tool_success 都归档（证据地板）', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'custom.debug.cause', value: { text: '根因 A' } },
    { op: 'add', path: 'suggested.findings', value: { text: '结论 B' } },
  ], 1);
  const cls = emergentClass(l);
  assert.equal(cls, 'debug');
  const policy = compressionPolicyFor(cls);
  assert.equal(disposeOf(toolErr, policy), 'archive', 'debug 下报错归档');
  assert.equal(disposeOf(toolOk, policy), 'archive', 'debug 下工具输出是诊断证据，归档');
});

test('P1 处置: 涌现类别 execution → 成功输出删（stdout 噪音），报错仍归档', () => {
  const l = createEmptyLedger('s');
  applyPatches(l, [
    { op: 'add', path: 'suggested.progress',  value: { text: '步骤1' } },
    { op: 'add', path: 'suggested.artifacts', value: { text: '产物1' } },
  ], 1);
  const cls = emergentClass(l);
  assert.equal(cls, 'execution');
  const policy = compressionPolicyFor(cls);
  assert.equal(disposeOf(toolErr, policy), 'archive', '任何类别报错都应归档');
  assert.equal(disposeOf(toolOk, policy), 'delete', 'execution 下成功输出是噪音');
});

test('P1 不变量: tool_error 在任何涌现类别下都归档（证据永不丢）', () => {
  for (const cls of ['debug', 'execution', 'brainstorm', 'default'] as const) {
    const policy = compressionPolicyFor(cls);
    assert.equal(disposeOf(toolErr, policy), 'archive', `${cls} 下报错应归档`);
  }
});

test('P1 特征识别: featureOf 正确分类五种消息', () => {
  assert.equal(featureOf(toolErr), 'tool_error');
  assert.equal(featureOf(toolOk), 'tool_success');
  assert.equal(featureOf(reasoning), 'assistant_reasoning');
  assert.equal(featureOf(action), 'assistant_action');
  assert.equal(featureOf(userMsg), 'user');
});
