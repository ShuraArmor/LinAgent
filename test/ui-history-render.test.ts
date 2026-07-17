import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { History } from '../src/ui/ink/History.tsx';
import type { HistoryEntry } from '../src/ui/ink/store.ts';
import { COLORS, toolTheme } from '../src/ui/ink/theme.ts';
import { stripAnsi, displayWidth } from '../src/ui/width.ts';

/** 输出里最宽一行占多少显示列（先剥 ANSI）。 */
function maxLineWidth(buf: string): number {
  return Math.max(0, ...buf.split('\n').map((l) => displayWidth(stripAnsi(l))));
}

/**
 * 把 History 渲染进一个假 TTY 流，收集 ANSI 输出做断言。
 * FORCE_COLOR=3 逼 chalk 走真彩色，这样能断言具体的 truecolor 转义。
 */
async function renderHistory(committed: HistoryEntry[], cols = 100): Promise<string> {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  out.columns = cols; out.rows = 40; out.isTTY = true;
  let buf = '';
  out.on('data', (c: Buffer) => { buf += c.toString(); });
  const { unmount } = render(
    React.createElement(History, { committed, streaming: null }),
    { stdout: out as unknown as NodeJS.WriteStream, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 60));
  unmount();
  return buf;
}

/** 拆 #rrggbb 成 {r,g,b}。 */
function hexRGB(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

test('history: 用户消息用圆角边框包起来', async () => {
  const buf = await renderHistory([{ id: 1, kind: 'user', text: '你好' }]);
  assert.match(buf, /[╭╮╰╯]/, '用户消息应有圆角边框');
  assert.match(buf, /你好/);
  assert.match(buf, /用户/);
});

test('history: 用户边框 = magenta 家族，agent 边框 = cyan 家族，二者不同', () => {
  // 具体 truecolor 转义依赖终端色深探测（易随环境降级），这里断言主题契约本身：
  // 两色不同、且分属 magenta / cyan 家族（R 高偏红紫 vs G/B 高偏青）。
  assert.notEqual(COLORS.userBorder, COLORS.agentBorder, '两色必须有区分度');
  const u = hexRGB(COLORS.userBorder);
  const a = hexRGB(COLORS.agentBorder);
  assert.ok(u.r > u.g, '用户色应偏品红（R>G）');
  assert.ok(a.b > a.r && a.g > a.r, 'agent 色应偏青（G、B 都 > R）');
});

test('history: assistant 与 final 都渲染成 agent 卡片（带边框 + Agent 标签）', async () => {
  const buf = await renderHistory([{ id: 1, kind: 'assistant', text: '流式收尾' }]);
  assert.match(buf, /[╭╮╰╯]/, 'assistant 也应包在边框里');
  assert.match(buf, /Agent/);
});

test('history: 超长行卡片不超终端宽度（防撑破边框回归）', async () => {
  const longText = '当前正在维护你的 Simulink Bridge 项目 Electron React FastAPI MATLAB Engine '
    + '桌面 GUI 控制 Simulink 仿真 mixed with English words that keep going and going 哦哦哦哦哦哦';
  // 窄终端：卡片应贴合终端宽度换行，不溢出。
  const at80 = await renderHistory([{ id: 1, kind: 'final', text: longText }], 80);
  assert.ok(maxLineWidth(at80) <= 80, `80 列终端下卡片不应超宽，实际 ${maxLineWidth(at80)}`);
  // 超宽终端：卡片有 100 列上限，不会拉满整屏。
  const at200 = await renderHistory([{ id: 2, kind: 'final', text: longText }], 200);
  assert.ok(maxLineWidth(at200) <= 100, `超宽终端下卡片应封顶 100 列，实际 ${maxLineWidth(at200)}`);
});

test('history: 卡片保留正文里的换行（markdown 段落）', async () => {
  const buf = await renderHistory([{ id: 1, kind: 'final', text: '第一段\n\n第二段' }], 100);
  assert.match(buf, /第一段/);
  assert.match(buf, /第二段/);
});

test('history: 会话卡片自带下间距（回车累积空行回归）', async () => {
  // 防回归：committed 卡片下边框后必须紧跟一行空行（marginBottom）。间距放在 committed 侧
  // 才能随 <Static> 永久滚动；若放在动态区的 marginTop，每次回车都会残留一行 orphan 空行。
  const buf = await renderHistory([{ id: 1, kind: 'user', text: '你好' }], 60);
  const clean = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, '');
  const afterCard = clean.slice(clean.lastIndexOf('╯') + 1);
  assert.match(afterCard, /^\s*\n\s*\n/, '卡片下框线后应有一行空行作为分隔（随卡片进 scrollback）');
});

/** 渲染一个流式（进行中）帧，返回清理后的输出。 */
async function renderStreaming(
  text: string, cols: number, rows: number, kind: 'assistant' | 'thinking' = 'assistant',
): Promise<string> {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  out.columns = cols; out.rows = rows; out.isTTY = true;
  let buf = '';
  out.on('data', (c: Buffer) => { buf += c.toString(); });
  const { unmount } = render(
    React.createElement(History, { committed: [], streaming: { kind, text } }),
    { stdout: out as unknown as NodeJS.WriteStream, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 60));
  unmount();
  return buf.replace(/\x1b\[\?25[lh]/g, '').replace(/\x1b\[2J\x1b\[3J\x1b\[H/g, '');
}

test('history: 流式一开始就有边框，内容在框里', async () => {
  const buf = await renderStreaming('西安现在晴天…', 80, 30);
  assert.match(buf, /[╭╮╰╯]/, '流式进行中就应带边框');
  assert.match(buf, /Agent/);
  assert.match(buf, /西安现在晴天/);
});

test('history: 超长流式框高受控为视口（防"双头"残框回归）', async () => {
  // 核心不变量：流式框高度 ≤ 终端高度，否则框头滚出屏幕顶部 Ink 擦不掉 → 双头残框。
  const rows = 30;
  const longText = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行 line ${i + 1}`).join('\n');
  const buf = await renderStreaming(longText, 80, rows);
  const rendered = buf.split('\n').filter((l) => l.trim()).length;
  assert.ok(rendered < rows, `渲染行数(${rendered})必须 < 终端高度(${rows})，否则会双头`);
  assert.match(buf, /[╭╮╰╯]/, '仍带边框');
  assert.match(buf, /上文 \d+ 行/, '超出视口应有"上文 N 行"提示');
  // 不应把全部 60 行都画出来
  assert.doesNotMatch(buf, /第 1 行/, '顶部旧内容应被视口滚掉');
  assert.match(buf, /第 60 行/, '尾部最新内容应可见');
});

test('history: 超长流式思考(thinking)也走视口截断，不撑爆动态区', async () => {
  const rows = 30;
  const longThink = Array.from({ length: 50 }, (_, i) => `思考第 ${i + 1} 点`).join('\n');
  const buf = await renderStreaming(longThink, 80, rows, 'thinking');
  const rendered = buf.split('\n').filter((l) => l.trim()).length;
  assert.ok(rendered < rows, `thinking 渲染行数(${rendered})必须 < 终端高度(${rows})`);
  assert.match(buf, /上文 \d+ 行/, 'thinking 超出视口也应有提示');
  assert.doesNotMatch(buf, /思考第 1 点/, 'thinking 顶部旧内容应被滚掉');
  assert.match(buf, /思考第 50 点/, 'thinking 尾部最新应可见');
});

test('store: 工具调用到来先 flush 流式，保证提交顺序（消除交叠遮盖）', async () => {
  const { UIStore } = await import('../src/ui/ink/store.ts');
  const s = new UIStore({
    turn: 0, provider: 'x', planMode: false, busy: false,
    tokensUsed: 0, contextWindow: 1000, sessionTitle: 't', sessionId: 's',
  });
  s.appendStream('assistant', '我先分析一下');
  assert.equal(s.getCommitted().length, 0, '流式进行中不进 committed');
  // 模拟 tool_call 到来：先 flush 再 push 工具行
  s.flushStream();
  s.push('tool_call', 'weather(...)', 'weather');
  const c = s.getCommitted();
  assert.equal(s.getStreaming(), null, 'flush 后流式动态区清空');
  assert.equal(c[0].kind, 'assistant', '先落定流式文本');
  assert.equal(c[1].kind, 'tool_call', '工具行接在文本之后');
});

test('history: 工具调用带专属图标', async () => {
  const buf = await renderHistory([
    { id: 1, kind: 'tool_call', text: 'weather(...)', toolName: 'weather' },
  ]);
  assert.ok(buf.includes(toolTheme('weather').icon), 'weather 应有专属图标');
  assert.match(buf, /weather/);
});

test('history: 高影响工具(bash_exec)标 ⚠ 预警', async () => {
  const buf = await renderHistory([
    { id: 1, kind: 'tool_call', text: 'bash_exec(...)', toolName: 'bash_exec' },
  ]);
  assert.ok(toolTheme('bash_exec').risky, 'bash_exec 应被标记为 risky');
  assert.match(buf, /⚠/, 'risky 工具应有预警符号');
});

test('history: 不同工具用不同颜色（区分度）', async () => {
  assert.notEqual(toolTheme('weather').color, toolTheme('bash_exec').color);
  assert.notEqual(toolTheme('memory').color, toolTheme('todo').color);
  assert.notEqual(toolTheme('calculator').color, toolTheme('fs_write').color);
});

test('history: 未登记工具走缺省主题，不崩', async () => {
  const buf = await renderHistory([
    { id: 1, kind: 'tool_call', text: 'some_mcp_tool(...)', toolName: 'some_mcp_tool' },
  ]);
  assert.match(buf, /some_mcp_tool/);
  assert.match(buf, /🔧/, '缺省工具用默认扳手图标');
});
