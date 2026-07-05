import { c, hr, symbols } from './ansi.ts';
import type { TraceEntry, ToolCall } from '../types.ts';
import { displayWidth, padEndCols, wrapCols, stripAnsi } from './width.ts';

export function banner(providerName: string, tools: string[]): string {
  const title = c.bold(c.cyan('LinAgent'));
  const sub = c.gray(`provider=${providerName}  工具=[${tools.join(', ')}]`);
  return `\n${title}  ${c.dim('最小可用 agent runtime')}\n${sub}\n${hr()}\n`;
}

export function userLine(text: string): string {
  return `${c.magenta(c.bold('用户'))}  ${c.gray(symbols.arrow)} ${text}`;
}

export function thoughtLine(t: string | undefined): string {
  if (!t) return '';
  return `${c.dim(symbols.brain + ' 思考:')} ${c.italic(c.dim(t))}`;
}

export function toolCallLine(call: ToolCall, turn: number): string {
  const args = JSON.stringify(call.args);
  return `${c.yellow(`${symbols.wrench} 工具[${turn}]`)} ${c.bold(call.name)}${c.gray('(')}${c.gray(args)}${c.gray(')')}`;
}

export function toolResultLine(name: string, ok: boolean, preview: string): string {
  const icon = ok ? c.green(symbols.check) : c.red(symbols.cross);
  const head = c.green(`${symbols.arrow}${symbols.arrow} ${name}`);
  return `  ${icon} ${head} ${c.gray(preview)}`;
}

/**
 * 用 box 画出最终答复。CJK 字符按 2 列宽计算，超过终端宽度会自动折行。
 * 传入的 answer 视为无 ANSI 的纯文本。
 */
export function finalBox(answer: string): string {
  const termCols = Math.max(40, (process.stdout.columns ?? 100) - 2);
  const maxInner = Math.min(termCols - 4, 96); // 左右各留 "│ " / " │"

  // 先按 \n 切，再按显示列宽 wrap
  const raw = stripAnsi(answer);
  const lines: string[] = [];
  for (const seg of raw.split('\n')) {
    if (seg === '') { lines.push(''); continue; }
    for (const piece of wrapCols(seg, maxInner)) lines.push(piece);
  }

  const width = Math.max(...lines.map((l) => displayWidth(l)), 16);
  const top = c.green('╭' + '─'.repeat(width + 2) + '╮');
  const bot = c.green('╰' + '─'.repeat(width + 2) + '╯');
  const body = lines
    .map((l) => c.green('│') + ' ' + padEndCols(l, width) + ' ' + c.green('│'))
    .join('\n');
  return `${top}\n${body}\n${bot}`;
}

export function errorLine(where: string, msg: string): string {
  return `${c.red(symbols.cross + ' 错误')} ${c.gray(`[${where}]`)} ${msg}`;
}

export function compressLine(folded: number, kept: number): string {
  return c.gray(`${symbols.gear} 已压缩：折叠 ${folded} 条 → 摘要 + 保留最近 ${kept} 条`);
}

export function statusLine(turns: number, traceLen: number, elapsedMs: number): string {
  return c.dim(`${symbols.info}  轮次=${turns}  trace+=${traceLen}  耗时=${(elapsedMs / 1000).toFixed(2)}s`);
}

export function traceDump(trace: TraceEntry[]): string {
  return trace
    .map((t) => {
      const time = new Date(t.timestamp).toISOString().slice(11, 23);
      const kind = padEndCols(t.kind, 12);
      const data = JSON.stringify(t.data);
      const color =
        t.kind === 'final' ? c.green :
        t.kind === 'error' ? c.red :
        t.kind === 'tool_call' ? c.yellow :
        t.kind === 'tool_result' ? c.blue :
        t.kind === 'compress' ? c.magenta :
        c.gray;
      return `${c.gray(time)}  T${t.turn}  ${color(kind)} ${c.dim(data)}`;
    })
    .join('\n');
}

export function sessionRow(id: string, title: string, msgs: number, todos: number, active: boolean): string {
  const mark = active ? c.green(symbols.check) : ' ';
  const idc = active ? c.bold(c.cyan(id)) : c.cyan(id);
  // padEnd 里的 id 带 ANSI 会让原生 padEnd 错，改用 padEndCols
  return `${mark}  ${padEndCols(idc, 24)}  ${padEndCols(title, 20)} ${c.gray(`msgs=${msgs}  todos=${todos}`)}`;
}
