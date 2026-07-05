import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokensOfText, estimateTokensOfMessage,
  categorize, breakdown, totalTokens, humanTokens,
} from '../src/tokens.ts';
import { tokenLine, tokenBarChart } from '../src/ui/tokens.ts';
import type { Message } from '../src/types.ts';

test('tokens: ASCII 大致 4 字符/token', () => {
  const t = estimateTokensOfText('hello world hello world');   // 23 字符
  // 23/4 = 5.75，向上取整 6
  assert.equal(t, 6);
});

test('tokens: CJK 每字 ~0.7 token', () => {
  const t = estimateTokensOfText('你好你好你好你好');            // 8 字
  // 8 / 1.4 = 5.7 → ceil 6
  assert.equal(t, 6);
});

test('tokens: 空字符串 = 0', () => {
  assert.equal(estimateTokensOfText(''), 0);
});

test('tokens: 结构开销 = 4 tokens/msg', () => {
  const m: Message = { role: 'user', content: 'hi' };
  assert.equal(estimateTokensOfMessage(m),
    estimateTokensOfText('hi') + 4);
});

test('tokens: categorize 正确识别 summary / memory_facts / 常规 system', () => {
  const sys: Message = { role: 'system', content: 'You are …' };
  const sum: Message = { role: 'system', content: '早期对话摘要：\n- 用户提问：...' };
  const mem: Message = { role: 'system', content: '关于本用户的已知信息（来自过往会话）:\n- identity:...' };
  const usr: Message = { role: 'user', content: 'hi' };
  const asst: Message = { role: 'assistant', content: '{"action":"final_answer"}' };
  const tool: Message = { role: 'tool', toolName: 'x', content: '{}' };
  assert.equal(categorize(sys), 'system');
  assert.equal(categorize(sum), 'summary');
  assert.equal(categorize(mem), 'memory_facts');
  assert.equal(categorize(usr), 'user');
  assert.equal(categorize(asst), 'assistant');
  assert.equal(categorize(tool), 'tool_result');
});

test('tokens: breakdown 累加到各类别', () => {
  const msgs: Message[] = [
    { role: 'system', content: 'sys prompt with tools' },
    { role: 'user', content: '查一下天气' },
    { role: 'assistant', content: 'thinking...' },
    { role: 'tool', toolName: 'weather', content: '{"result":"sunny"}' },
    { role: 'assistant', content: '晴天' },
  ];
  const b = breakdown(msgs);
  assert.ok(b.system > 0);
  assert.ok(b.user > 0);
  assert.ok(b.assistant > 0);
  assert.ok(b.tool_result > 0);
  assert.equal(b.summary, 0);
  // 总和 = sum of parts
  const total =
    b.system + b.user + b.assistant + b.tool_result + b.summary;
  assert.equal(total, totalTokens(b));
});

test('tokens: humanTokens 格式化', () => {
  assert.equal(humanTokens(0), '0');
  assert.equal(humanTokens(42), '42');
  assert.equal(humanTokens(999), '999');
  assert.equal(humanTokens(1200), '1.2k');
  assert.equal(humanTokens(12000), '12k');
  assert.equal(humanTokens(1_500_000), '1.5M');
});

test('ui/tokens: tokenLine 含总量与百分比', () => {
  const b = breakdown([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好' },
  ]);
  const line = tokenLine(b, 128_000);
  assert.match(line, /tokens/);
  assert.match(line, /128k/);
  assert.match(line, /%/);
});

test('ui/tokens: tokenBarChart 每一类别都出现在图里', () => {
  const b = breakdown([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok' },
    { role: 'tool', toolName: 't', content: 'r' },
    { role: 'system', content: '早期对话摘要：foo' },
    { role: 'system', content: '关于本用户的已知信息（来自过往会话）:...' },
  ]);
  const chart = tokenBarChart(b, 128_000);
  for (const label of ['system', 'user', 'assistant', 'tool_result', 'summary', 'memory']) {
    assert.match(chart, new RegExp(label));
  }
});

test('tokens: extras.systemBase 计入 system 类别', () => {
  const b = breakdown(
    [{ role: 'user', content: '你好' }],
    { systemBase: 'You are LinAgent. tool schemas ...' },
  );
  assert.ok(b.system > 0, 'system 段应该被算入');
  assert.ok(b.user > 0);
});

test('tokens: extras.memory 计入 memory_facts 而不是 system', () => {
  const b = breakdown(
    [{ role: 'user', content: '你好' }],
    { memory: '关于本用户的已知信息:\n- identity:\n    · 住在杭州' },
  );
  assert.ok(b.memory_facts > 0, 'memory 段应该算到 memory_facts');
  assert.equal(b.system, 0);
});
