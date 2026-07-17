import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { MemoryMemoryStore, addManual } from '../src/memory.ts';
import { MemoryLedgerStore, MemoryArchiveStore } from '../src/ledger/index.ts';
import { MockLLM, finalAnswer } from './mock-llm.ts';
import type { MemoryStore } from '../src/memory.ts';
import type { Session } from '../src/session.ts';

/**
 * 核心不变量：会话启动后 system prompt（messages[0]）一字不变，保住 provider 前缀缓存。
 * 这是整套记忆系统重构的目的——见 plan / [[linagent-memory-system-redesign]]。
 */

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

function withLedger(store: MemoryStore) {
  return new Agent(
    new MockLLM([finalAnswer('a'), finalAnswer('b'), finalAnswer('c')]),
    buildDefaultRegistry(), cfg,
    { store, userId: 'default' },
    undefined,
    { store: new MemoryLedgerStore(), archive: new MemoryArchiveStore(), language: 'zh' },
  );
}

test('cache: 同一会话连跑 3 轮，system prompt 完全一致', async () => {
  const store = new MemoryMemoryStore();
  addManual(store.load('default'), 'identity', '住在杭州', { session: 'x', turn: 0 }, Date.now());
  store.save(store.load('default'));

  const llm = new MockLLM([finalAnswer('1'), finalAnswer('2'), finalAnswer('3')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' },
    undefined, { store: new MemoryLedgerStore(), archive: new MemoryArchiveStore(), language: 'zh' });
  const s: Session = new SessionManager().create();

  await agent.chat(s, '第一问');
  await agent.chat(s, '第二问');
  await agent.chat(s, '第三问');

  const sys = llm.calls.map((msgs) => msgs.find((m) => m.role === 'system')?.content ?? '');
  assert.equal(sys.length, 3);
  assert.equal(sys[0], sys[1], '第 2 轮 system 应与第 1 轮完全一致');
  assert.equal(sys[1], sys[2], '第 3 轮 system 应与第 1 轮完全一致');
});

test('cache: 账本内容变化不影响 system（走 messages 末尾动态消息）', async () => {
  const store = new MemoryMemoryStore();
  const llm = new MockLLM([finalAnswer('1'), finalAnswer('2')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' },
    undefined, { store: new MemoryLedgerStore(), archive: new MemoryArchiveStore(), language: 'zh' });
  const s = new SessionManager().create();

  await agent.chat(s, '第一问');
  // 第一轮后账本可能被 preset 标记等改动；第二轮 system 仍应不变。
  await agent.chat(s, '第二问');

  const sys1 = llm.calls[0].find((m) => m.role === 'system')?.content ?? '';
  const sys2 = llm.calls[1].find((m) => m.role === 'system')?.content ?? '';
  assert.equal(sys1, sys2, '账本演化不该改 system 前缀');
});

test('cache: 会话内 memory 变化不刷新已冻结的 system（下个会话才生效）', async () => {
  const store = new MemoryMemoryStore();
  const llm = new MockLLM([finalAnswer('1'), finalAnswer('2')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' });
  const s = new SessionManager().create();

  await agent.chat(s, '第一问');
  // 会话中途新增一条 identity
  addManual(store.load('default'), 'identity', '母语中文', { session: 'x', turn: 1 }, Date.now());
  store.save(store.load('default'));
  await agent.chat(s, '第二问');

  const sys1 = llm.calls[0].find((m) => m.role === 'system')?.content ?? '';
  const sys2 = llm.calls[1].find((m) => m.role === 'system')?.content ?? '';
  assert.equal(sys1, sys2, '会话内冻结：中途加的记忆本会话不进 system');
  assert.doesNotMatch(sys2, /母语中文/, '新记忆本会话不生效');

  // 新会话则应包含新记忆
  const llm2 = new MockLLM([finalAnswer('x')]);
  const agent2 = new Agent(llm2, buildDefaultRegistry(), cfg, { store, userId: 'default' });
  await agent2.chat(new SessionManager().create(), '你好');
  const sysNew = llm2.calls[0].find((m) => m.role === 'system')?.content ?? '';
  assert.match(sysNew, /母语中文/, '下个会话应含新记忆');
});

test('cache: 账本当前内容作为 messages 末尾的 system 消息注入', async () => {
  const store = new MemoryMemoryStore();
  const ledgerStore = new MemoryLedgerStore();
  // 预填账本一条 finding
  const ledger = ledgerStore.load('will-be-overwritten', 'zh');
  void ledger;
  const llm = new MockLLM([finalAnswer('ok')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' },
    undefined, { store: ledgerStore, archive: new MemoryArchiveStore(), language: 'zh' });
  const s = new SessionManager().create();
  // 直接给该会话账本塞内容
  const l = ledgerStore.load(s.id, 'zh');
  l.core.intent = '重写项目';
  ledgerStore.save(l);

  await agent.chat(s, '继续');
  const msgs = llm.calls[0];
  // 第一条是冻结 system；账本内容应作为末尾的 system 消息（不是 messages[0]）。
  assert.equal(msgs[0].role, 'system');
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'system', '末尾应是账本动态 system 消息');
  assert.match(last.content, /重写项目/, '末尾消息含账本当前内容');
  // 账本"当前内容"（intent 值）不该在冻结 system 里——冻结的只有账本"指令+few-shot"。
  assert.doesNotMatch(msgs[0].content, /重写项目/, '账本当前内容不在冻结 system 里');
});

test('preset: 首轮按用户输入选 preset（自演化入口），不是 session.title', async () => {
  const store = new MemoryMemoryStore();
  // 排错类输入 → 应选 debug preset（其 few-shot example 含 "排查 npm test"）。
  const llm = new MockLLM([finalAnswer('ok')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' },
    undefined, { store: new MemoryLedgerStore(), archive: new MemoryArchiveStore(), language: 'zh' });
  const s = new SessionManager().create();   // title=window-N，不含任何关键词
  await agent.chat(s, '这个 bug 为什么会报错，帮我排查一下');

  const sys = llm.calls[0].find((m) => m.role === 'system')?.content ?? '';
  // debug preset 的 few-shot example 特征串
  assert.match(sys, /排查 npm test|causal_chain/, '排错输入应选中 debug preset 的 few-shot');
});

test('preset: 执行类输入 → 选 execution preset', async () => {
  const store = new MemoryMemoryStore();
  const llm = new MockLLM([finalAnswer('ok')]);
  const agent = new Agent(llm, buildDefaultRegistry(), cfg, { store, userId: 'default' },
    undefined, { store: new MemoryLedgerStore(), archive: new MemoryArchiveStore(), language: 'zh' });
  const s = new SessionManager().create();
  await agent.chat(s, '帮我把项目部署到 staging');

  const sys = llm.calls[0].find((m) => m.role === 'system')?.content ?? '';
  // execution preset few-shot 特征：部署到 staging / deploy.yml
  assert.match(sys, /部署到 staging|deploy\.yml/, '执行类输入应选中 execution preset');
});
