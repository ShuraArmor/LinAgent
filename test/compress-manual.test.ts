import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { SessionManager } from '../src/session.ts';
import { MemoryLedgerStore, MemoryArchiveStore, applyPatches } from '../src/ledger/index.ts';
import { MockLLM } from './mock-llm.ts';
import type { Message } from '../src/types.ts';

/**
 * 手动压缩 Agent.compressNow（/compress 命令的后端）。
 * 走账本驱动的非破坏归档路径，force=true 跳过 token 阈值。
 */

function agentWithLedger() {
  const reg = buildDefaultRegistry();
  const llm = new MockLLM();
  const ledgerStore = new MemoryLedgerStore();
  const archive = new MemoryArchiveStore();
  const agent = new Agent(llm, reg, DEFAULT_AGENT_CONFIG, undefined, undefined, {
    store: ledgerStore,
    archive,
    language: 'zh',
  });
  return { agent, archive, ledgerStore };
}

/** 造一段有 head/middle/tail 结构的长历史。 */
function seedHistory(s: { history: Message[] }, middle = 6) {
  s.history.push({ role: 'user', content: '最初的目标：重写整个项目' });
  for (let i = 0; i < middle; i++) {
    s.history.push({ role: 'assistant', content: `中间步骤 ${i} ` + '内容'.repeat(20) });
    s.history.push({ role: 'tool', toolName: 'fs_read', content: '文件内容 ' + '数据'.repeat(20) });
  }
  s.history.push({ role: 'user', content: '最近的问题' });
  s.history.push({ role: 'assistant', content: '最近的回答' });
}

test('compressNow: 手动压缩把中段归档，history 变短', async () => {
  const { agent, archive } = agentWithLedger();
  const s = new SessionManager().create();
  seedHistory(s, 6);
  const before = s.history.length;

  const r = await agent.compressNow(s);

  assert.equal(r.compressed, true, '有中段就应压缩');
  assert.ok(r.archived > 0, '应归档了消息');
  assert.ok(s.history.length < before, `history 应变短：${before} → ${s.history.length}`);
  assert.equal(archive.listForSession(s.id).length, 1, '归档区应有一段');
});

test('compressNow: 保头保尾——最初目标和最近一条仍在', async () => {
  const { agent } = agentWithLedger();
  const s = new SessionManager().create();
  seedHistory(s, 6);
  const head = s.history[0].content;
  const tailLast = s.history[s.history.length - 1].content;

  await agent.compressNow(s);

  assert.ok(s.history.some((m) => m.content === head), '最初的用户目标应逐字保留');
  assert.equal(s.history[s.history.length - 1].content, tailLast, '最近一条应逐字保留');
});

test('compressNow: 短历史 no-op（无可归档中段）', async () => {
  const { agent } = agentWithLedger();
  const s = new SessionManager().create();
  s.history.push({ role: 'user', content: '你好' });
  s.history.push({ role: 'assistant', content: '你好，有什么可以帮你？' });

  const r = await agent.compressNow(s);
  assert.equal(r.compressed, false, '太短没有中段应 no-op');
  assert.equal(s.history.length, 2, 'history 不应被动');
});

test('compressNow: 未启用账本 archive 时返回 not-compressed', async () => {
  const reg = buildDefaultRegistry();
  const llm = new MockLLM();
  const agent = new Agent(llm, reg, DEFAULT_AGENT_CONFIG);  // 无 ledger
  const s = new SessionManager().create();
  seedHistory(s, 6);

  const r = await agent.compressNow(s);
  assert.equal(r.compressed, false, '没账本 archive 就不做账本压缩');
});

test('compressNow: 账本为空时 ledgerItems=0（提示无结构化摘要）', async () => {
  const { agent } = agentWithLedger();  // 账本从未被填
  const s = new SessionManager().create();
  seedHistory(s, 6);

  const r = await agent.compressNow(s);
  assert.equal(r.compressed, true);
  assert.equal(r.ledgerItems, 0, '空账本应报 0 条，UI 据此提醒用户');
});

test('compressNow: 账本有内容时 ledgerItems>0', async () => {
  const { agent, ledgerStore } = agentWithLedger();
  const s = new SessionManager().create();
  // 先往该会话账本里填两条，再压缩
  const ledger = ledgerStore.load(s.id, 'zh');
  applyPatches(ledger, [
    { op: 'replace', path: 'core.intent', value: '重写项目' },
    { op: 'add', path: 'suggested.findings', value: { text: '根因是连接池未释放' } },
    { op: 'add', path: 'suggested.decisions', value: { text: '选用方案 B' } },
  ], 1);
  ledgerStore.save(ledger);
  seedHistory(s, 6);

  const r = await agent.compressNow(s);
  assert.equal(r.compressed, true);
  assert.ok(r.ledgerItems >= 2, `账本有内容应报 >0 条，实际 ${r.ledgerItems}`);
});
