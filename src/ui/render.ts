import { c, hr, symbols } from './ansi.ts';
import type { TraceEntry, ToolCall } from '../types.ts';
import { displayWidth, padEndCols, wrapCols, stripAnsi } from './width.ts';
import { renderLogo, logoTagline } from './logo.ts';

export function banner(providerName: string, tools: string[]): string {
  const logo = renderLogo();
  const tagline = logoTagline();
  const sub = c.gray(`provider=${providerName}  工具=[${tools.join(', ')}]`);
  return `\n${logo}\n\n${tagline}\n${sub}\n${hr()}\n`;
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
 * 把一条 `tool_result` trace 的 data 安全渲染成 { name, preview }。
 * 两种来源、两种形状：
 *   - 普通工具：{ name, result }
 *   - 后台任务完成通知（drainCompleted）：{ backgroundTask, status }（没有 name/result）
 * 关键坑：`JSON.stringify(undefined)` 返回的是值 `undefined`（不是字符串），
 * 直接 `.slice()` 会抛 "Cannot read properties of undefined (reading 'slice')"。
 * 所以这里对 result 缺失/序列化为 undefined 的情况兜底，绝不让渲染把整轮打挂。
 */
export function toolResultPreview(
  data: { name?: string; result?: unknown; backgroundTask?: string; status?: string },
  max = 120,
): { name: string; preview: string } {
  if (data.backgroundTask) {
    return { name: `后台任务 ${data.backgroundTask}`, preview: `状态: ${data.status ?? '未知'}` };
  }
  const name = data.name ?? '(unknown)';
  const json = JSON.stringify(data.result);
  const preview = json === undefined ? '(无返回值)' : json.slice(0, max);
  return { name, preview };
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

/**
 * 压缩事件有两种 trace 形状，来自两条不同的压缩路径：
 *   - FIFO 摘要路径：       { folded, kept }
 *   - 账本归档路径(archive)：{ archived, beforeTokens, afterTokens, savedPct }
 * 之前只按 FIFO 形状取 folded/kept，账本路径命中就渲染成 "折叠 undefined 条"。
 * 这里按实际字段判别，缺字段也兜底成数字，绝不显示 undefined。
 */
export function compressLine(data: {
  folded?: number; kept?: number;
  archived?: number; beforeTokens?: number; afterTokens?: number; savedPct?: number;
}): string {
  // 账本归档路径：有 token 数或 archived 字段。
  if (data.beforeTokens !== undefined || data.afterTokens !== undefined || data.archived !== undefined) {
    const archived = data.archived ?? 0;
    const before = data.beforeTokens ?? 0;
    const after = data.afterTokens ?? 0;
    const pct = data.savedPct ?? 0;
    return c.gray(`${symbols.gear} 已压缩：归档 ${archived} 条 → tokens ${before}→${after}（省 ${pct}%）`);
  }
  // FIFO 摘要路径。
  const folded = data.folded ?? 0;
  const kept = data.kept ?? 0;
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
