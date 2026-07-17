import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryArchiveStore, tryCompress, createEmptyLedger, applyPatches,
  DEFAULT_TRIGGER, parseHandle, buildTriggerConfig,
  shouldCompress, pickTailStartIndex,
} from '../src/ledger/index.ts';
import type { Message } from '../src/types.ts';

// 生成一段够长的 CJK 内容 —— 触发压缩阈值
function bigContent(chars: number): string {
  return '压'.repeat(chars);
}

// 建一段有 head/middle/tail 结构的假 history
function makeHistory(middleCount: number, size = 3000): Message[] {
  const h: Message[] = [];
  h.push({ role: 'user', content: '最初的用户目标：帮我部署项目' });
  for (let i = 0; i < middleCount; i++) {
    h.push({ role: 'assistant', content: bigContent(size) });
    h.push({ role: 'tool', toolName: 'fs_read', content: bigContent(size) });
  }
  // 最近的对话：保尾会保住这几条
  h.push({ role: 'user', content: '再看看 deploy.yml 里的 secret' });
  h.push({ role: 'assistant', content: '好的' });
  return h;
}

test('shouldCompress: 不达阈值不触发', () => {
  const cfg = buildTriggerConfig({ contextWindow: 100_000, outputReserve: 20_000, thresholdPercent: 0.6 });
  // usable=80k, threshold=48k
  const short: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const r = shouldCompress(short, 0, cfg);
  assert.equal(r.yes, false);
});

test('shouldCompress: 超阈值触发', () => {
  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.5 });
  // usable=16k, threshold=8k
  const bulky = makeHistory(3);  // ~几万 CJK 字符 → 几万 token
  const r = shouldCompress(bulky, 0, cfg);
  assert.equal(r.yes, true);
  assert.ok(r.totalInput >= r.threshold);
});

test('pickTailStartIndex: 至少保住 minTailMessages', () => {
  const cfg = buildTriggerConfig({
    contextWindow: 10_000, outputReserve: 2_000, thresholdPercent: 0.5,
    tailBudgetPercent: 0.01,  // 预算极小，逼它退到最小条数下限
    minTailMessages: 4,
  });
  const h = makeHistory(10);
  const idx = pickTailStartIndex(h, cfg);
  assert.ok(h.length - idx >= 4, `实际保留 ${h.length - idx} 条，应 >= 4`);
});

test('tryCompress: 达阈值 → 归档中段 → 返回句柄', () => {
  const arch = new MemoryArchiveStore();
  const history = makeHistory(6);           // 大量中段
  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });

  const out = tryCompress({
    session_id: 's1',
    history,
    extraSystemText: '',
    turn: 8,
    cfg,
    archive: arch,
  });

  assert.equal(out.compressed, true);
  assert.ok(out.handle);
  assert.ok(parseHandle(out.handle!));
  assert.ok(out.archived > 0);
  // 压缩后总 token 应该少一些
  assert.ok(out.afterTokens < out.beforeTokens, `压后 ${out.afterTokens} 应小于压前 ${out.beforeTokens}`);
});

test('tryCompress: 保头 + 保尾 —— 用户最初一条和最近几条留在 history', () => {
  const arch = new MemoryArchiveStore();
  const history = makeHistory(6);
  const originalHead = history[0].content;
  const originalTailLast = history[history.length - 1].content;

  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });
  const out = tryCompress({
    session_id: 's1', history, extraSystemText: '', turn: 8, cfg, archive: arch,
  });

  assert.equal(out.compressed, true);
  // 保头逐字在
  assert.ok(out.history.some((m) => m.content === originalHead));
  // 保尾最后一条逐字在
  assert.ok(out.history[out.history.length - 1].content === originalTailLast);
});

test('tryCompress: 归档的原文能 recall 回来', () => {
  const arch = new MemoryArchiveStore();
  const history = makeHistory(4);
  const middleUnique = history[2].content;   // 中段某条独一无二的内容

  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });
  const out = tryCompress({
    session_id: 's1', history, extraSystemText: '', turn: 5, cfg, archive: arch,
  });
  assert.equal(out.compressed, true);

  // 归档段能通过 store.load 拿回来
  const segId = parseHandle(out.handle!)!;
  const seg = arch.load('s1', segId);
  assert.ok(seg);
  // 中段那条独特内容在归档里
  assert.ok(seg!.messages.some((m) => m.content === middleUnique));
});

test('tryCompress: 视图里插了一条占位符提示 agent 用 recall_archive', () => {
  const arch = new MemoryArchiveStore();
  const history = makeHistory(5);
  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });
  const out = tryCompress({
    session_id: 's1', history, extraSystemText: '', turn: 6, cfg, archive: arch,
  });
  assert.equal(out.compressed, true);
  // 新格式：合并摘要一条 system 消息，标题 "【已压缩 @segN …】"，含 recall_archive 提示。
  const summary = out.history.find((m) => m.content.startsWith('【已压缩 @seg'));
  assert.ok(summary, '应有一条压缩摘要消息');
  assert.match(summary!.content, /recall_archive/);
});

test('tryCompress: 未达阈值 → no-op，原样返回', () => {
  const arch = new MemoryArchiveStore();
  const short: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const cfg = buildTriggerConfig({ contextWindow: 100_000, outputReserve: 20_000, thresholdPercent: 0.6 });
  const out = tryCompress({
    session_id: 's1', history: short, extraSystemText: '', turn: 1, cfg, archive: arch,
  });
  assert.equal(out.compressed, false);
  assert.equal(out.archived, 0);
  assert.equal(out.history, short);   // 同一引用
  // 归档区里没东西
  assert.equal(arch.listForSession('s1').length, 0);
});

test('tryCompress: force=true → 未达阈值也压缩（手动 /compress）', () => {
  const arch = new MemoryArchiveStore();
  // 有 head/middle/tail 结构，但整体远未达阈值
  const history = makeHistory(4, 50);
  const cfg = buildTriggerConfig({ contextWindow: 1_000_000, outputReserve: 20_000, thresholdPercent: 0.9 });
  // 先确认不 force 时确实不压
  const noop = tryCompress({ session_id: 's1', history, extraSystemText: '', turn: 5, cfg, archive: arch });
  assert.equal(noop.compressed, false, '未 force 且未达阈值应 no-op');
  // force 后应压
  const forced = tryCompress({ session_id: 's1', history, extraSystemText: '', turn: 5, cfg, archive: arch, force: true });
  assert.equal(forced.compressed, true, 'force 应无视阈值直接压');
  assert.ok(forced.archived > 0);
  assert.ok(forced.handle && parseHandle(forced.handle));
});

test('tryCompress: force=true 但 history 太短仍 no-op（无可归档中段）', () => {
  const arch = new MemoryArchiveStore();
  const short: Message[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const cfg = buildTriggerConfig();
  const out = tryCompress({ session_id: 's1', history: short, extraSystemText: '', turn: 1, cfg, archive: arch, force: true });
  assert.equal(out.compressed, false, 'force 也救不了没有中段的短历史');
});

test('tryCompress: 账本条目被打上 archived_ref', () => {
  const arch = new MemoryArchiveStore();
  const history = makeHistory(5);
  const ledger = createEmptyLedger('s1');
  applyPatches(ledger, [
    { op: 'replace', path: 'core.intent', value: '部署项目' },
    { op: 'add', path: 'suggested.findings', value: { text: 'staging 通了' } },
    { op: 'add', path: 'suggested.decisions', value: { text: '用 CI 部署' } },
  ], 3);

  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });
  const out = tryCompress({
    session_id: 's1', history, ledger, extraSystemText: '', turn: 6, cfg, archive: arch,
  });
  assert.equal(out.compressed, true);
  // 账本条目现在带 archived_ref = 本次的句柄
  const finding = ledger.suggested.findings![0];
  const decision = ledger.suggested.decisions![0];
  assert.equal(finding.archived_ref, out.handle);
  assert.equal(decision.archived_ref, out.handle);
});

test('tryCompress: 已有 archived_ref 的条目不被覆盖（保持指向更老的归档）', () => {
  const arch = new MemoryArchiveStore();
  const ledger = createEmptyLedger('s1');
  applyPatches(ledger, [
    { op: 'add', path: 'suggested.findings', value: { text: 'A' } },
  ], 1);
  ledger.suggested.findings![0].archived_ref = '@seg7';   // 手工设：假装以前压缩过

  const history = makeHistory(4);
  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });
  tryCompress({
    session_id: 's1', history, ledger, extraSystemText: '', turn: 5, cfg, archive: arch,
  });
  // 老的 archived_ref 保留
  assert.equal(ledger.suggested.findings![0].archived_ref, '@seg7');
});

test('tryCompress: 二次压缩 —— 新的中段进新 seg，老占位符保留', () => {
  const arch = new MemoryArchiveStore();
  let history = makeHistory(4);
  const cfg = buildTriggerConfig({ contextWindow: 20_000, outputReserve: 4_000, thresholdPercent: 0.4 });

  const out1 = tryCompress({
    session_id: 's1', history, extraSystemText: '', turn: 5, cfg, archive: arch,
  });
  assert.equal(out1.compressed, true);
  history = out1.history;

  // 再堆一些新消息模拟继续对话
  for (let i = 0; i < 6; i++) {
    history.push({ role: 'assistant', content: '压'.repeat(3000) });
    history.push({ role: 'tool', toolName: 'x', content: '压'.repeat(3000) });
  }

  const out2 = tryCompress({
    session_id: 's1', history, extraSystemText: '', turn: 10, cfg, archive: arch,
  });
  assert.equal(out2.compressed, true);
  assert.equal(parseHandle(out2.handle!), 'seg2');

  // history 里同时能看到 seg1 和 seg2 的压缩摘要（老摘要保留，累积归档链）
  const summaries = out2.history.filter((m) => m.content.startsWith('【已压缩 @seg'));
  assert.equal(summaries.length, 2);
});
