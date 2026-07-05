/**
 * Raw-mode 交互式选择器（↑ / ↓ / Enter / q / Esc）。
 *
 * 用于工具调用前的审批弹窗。特意不引三方 TUI 库 —— 直接读 stdin，
 * 用 ANSI 光标控制原地重绘。
 */

import { stdin, stdout } from 'node:process';
import { c, symbols } from './ansi.ts';
import { displayWidth, padEndCols, wrapCols, stripAnsi } from './width.ts';

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  description?: string;
  hotkey?: string;
}

export interface SelectOpts<V extends string> {
  title: string;
  /** 详细信息面板；数组每一项占一行。 */
  detail?: string[];
  options: SelectOption<V>[];
  /** 默认高亮下标，默认 0。 */
  defaultIndex?: number;
}

/**
 * 弹出选择器；解析为选中的 value。若用户按 Esc/q，返回 null。
 * 若 stdin 不是 TTY（例如通过管道 / 测试环境），会走非交互回退：
 *   打印一次选项 + 提示，然后 resolve 到 defaultIndex 对应的 value。
 */
export function select<V extends string>(opts: SelectOpts<V>): Promise<V | null> {
  return new Promise((resolve) => {
    const options = opts.options;
    if (options.length === 0) { resolve(null); return; }
    let idx = Math.max(0, Math.min(options.length - 1, opts.defaultIndex ?? 0));

    // 非交互回退（管道 / CI）
    if (!stdin.isTTY) {
      stdout.write(box(opts, idx) + '\n');
      stdout.write(c.gray('(非交互终端：自动选择默认项)\n'));
      resolve(options[idx].value);
      return;
    }

    let firstDraw = true;
    let lastHeight = 0;

    const draw = () => {
      if (!firstDraw) {
        // 回到上次绘制的开头，把之前的内容清干净
        stdout.write(`\x1b[${lastHeight}A\x1b[0J`);
      }
      const rendered = box(opts, idx);
      stdout.write(rendered + '\n');
      lastHeight = rendered.split('\n').length + 1;
      firstDraw = false;
    };

    const finish = (value: V | null) => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch { /* noop */ }
      // 有意不调 stdin.pause()：那会把 stdin 从活跃 handle 表里摘掉，
      // 在恰好没有其它 pending I/O 时会让进程"没事干"→ 自然退出。
      // stdin 的暂停/恢复由调用方（readline）负责。
      stdout.write('\n');
      resolve(value);
    };

    const onData = (data: Buffer) => {
      const key = data.toString('utf8');
      // Enter / Return
      if (key === '\r' || key === '\n') { finish(options[idx].value); return; }
      // Esc / q → 取消（不含 Ctrl-C —— Ctrl-C 交给上层，走进程级 SIGINT 语义）
      if (key === '\x1b' || key === 'q') {
        finish(null); return;
      }
      // Ctrl-C：清理 raw-mode 后转发给上层，让进程决定退出还是清空当前输入
      if (key === '\x03') {
        try { stdin.setRawMode(false); } catch { /* noop */ }
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(null);
        // 触发一次进程级 SIGINT，让 readline 的 SIGINT handler 走它自己的逻辑
        process.kill(process.pid, 'SIGINT');
        return;
      }
      // 上下箭头
      if (key === '\x1b[A' || key === 'k') { idx = (idx - 1 + options.length) % options.length; draw(); return; }
      if (key === '\x1b[B' || key === 'j') { idx = (idx + 1) % options.length; draw(); return; }
      // 数字或 hotkey 直接选中
      const num = Number(key);
      if (Number.isInteger(num) && num >= 1 && num <= options.length) {
        idx = num - 1; draw();
        // 快捷键立即确认
        finish(options[idx].value);
        return;
      }
      for (let i = 0; i < options.length; i++) {
        if (options[i].hotkey && key.toLowerCase() === options[i].hotkey!.toLowerCase()) {
          idx = i; draw(); finish(options[i].value); return;
        }
      }
    };

    try { stdin.setRawMode(true); } catch { /* 某些环境不支持 */ }
    stdin.resume();
    stdin.on('data', onData);
    draw();
  });
}

function box<V extends string>(opts: SelectOpts<V>, activeIdx: number): string {
  const termCols = Math.max(48, (stdout.columns ?? 100) - 2);
  const maxInner = Math.min(termCols - 4, 96);

  const rawLines: string[] = [];
  rawLines.push(c.bold(c.yellow(opts.title)));
  if (opts.detail && opts.detail.length) {
    rawLines.push('');
    for (const d of opts.detail) {
      for (const piece of wrapCols(stripAnsi(d), maxInner)) rawLines.push(c.gray(piece));
    }
  }
  rawLines.push('');
  opts.options.forEach((o, i) => {
    const marker = i === activeIdx ? c.green(symbols.arrow) : ' ';
    const num = c.dim(`${i + 1}.`);
    const labelC = i === activeIdx ? c.bold(c.cyan(o.label)) : o.label;
    const hint = o.description ? '  ' + c.gray(o.description) : '';
    rawLines.push(`${marker} ${num} ${labelC}${hint}`);
  });
  rawLines.push('');
  rawLines.push(c.dim('↑/↓ 或 j/k 移动 · Enter 确认 · 1-9 直选 · q / Esc 取消'));

  // 计算最大列宽再画边框
  const width = Math.min(
    maxInner,
    Math.max(24, ...rawLines.map((l) => displayWidth(l))),
  );
  const top = c.yellow('╭' + '─'.repeat(width + 2) + '╮');
  const bot = c.yellow('╰' + '─'.repeat(width + 2) + '╯');
  const body = rawLines
    .map((l) => c.yellow('│') + ' ' + padEndCols(l, width) + ' ' + c.yellow('│'))
    .join('\n');
  return `${top}\n${body}\n${bot}`;
}
