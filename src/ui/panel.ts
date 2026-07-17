import { c, symbols } from './ansi.ts';
import { displayWidth, truncateCols } from './width.ts';

/** spinner 动画帧（与 spinner.ts 一致，保持视觉统一）。 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export type PanelRowStatus = 'waiting' | 'running' | 'ok' | 'failed';

interface Row {
  id: string;
  label: string;
  status: PanelRowStatus;
  note?: string;
  startedAt?: number;
}

/** 可注入的最小 stream 接口（默认 process.stdout；测试可传 mock）。 */
export interface PanelStream {
  write(s: string): void;
  isTTY?: boolean;
  columns?: number;
}

/**
 * 多行实时状态面板。
 *
 * 用于 /workflow 同时展示多个子 agent 的状态：每行一个节点，
 * 靠一个 80ms 定时器整体原地重绘（spinner 动画 + running 耗时）。
 *
 * 原地重绘技术与 ui/prompt.ts 的审批弹窗一致：记录上次绘制高度，
 * 非首帧先 `\x1b[{n}A`（上移 n 行）+ `\x1b[0J`（清到屏幕底）回到开头再重画。
 *
 * 非 TTY（管道 / CI）：完全静默，只维护内部状态，不产生任何输出。
 *
 * 与审批弹窗的屏幕冲突：审批也用光标控制 + raw stdin，若面板正在刷新会互相踩屏。
 * 故暴露 pause()/resume()：审批前 pause（停定时器 + 擦除面板让出光标），审批后 resume。
 */
export class MultiStatusPanel {
  private rows: Row[];
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private lastHeight = 0;
  private active = false;
  private readonly out: PanelStream;

  constructor(rows: Array<{ id: string; label: string }>, stream: PanelStream = process.stdout) {
    this.rows = rows.map((r) => ({ id: r.id, label: r.label, status: 'waiting' }));
    this.out = stream;
  }

  private get isTTY(): boolean {
    return Boolean(this.out.isTTY);
  }

  start(): void {
    if (!this.isTTY || this.active) return;
    this.active = true;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 80);
  }

  /** 更新某行状态；未知 id 静默忽略。running → 记录起始时间用于显示耗时。 */
  set(id: string, status: PanelRowStatus, note?: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = status;
    if (note !== undefined) row.note = note;
    if (status === 'running' && row.startedAt === undefined) row.startedAt = Date.now();
    if (this.active) this.render();
  }

  /** 暂停：停定时器、擦除面板、把光标留在面板起始处（供审批弹窗接管屏幕）。 */
  pause(): void {
    if (!this.active) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.erase();
    this.active = false;
  }

  /** 恢复：重新接管屏幕、整体重画、重启定时器。 */
  resume(): void {
    if (!this.isTTY || this.active) return;
    this.active = true;
    this.lastHeight = 0; // 面板被擦掉了，从头画
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 80);
  }

  /**
   * 停止面板。
   * @param finalRender true=保留最后一帧（完成状态留在屏幕上，调用方可在下方继续打印）；
   *                    false=擦除面板不留痕。
   */
  stop(finalRender = true): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.active) { if (!finalRender) this.erase(); return; }
    if (finalRender) {
      this.render(); // 画最后一帧（此刻各行多为 ok/failed，无 spinner 抖动）
    } else {
      this.erase();
    }
    this.active = false;
  }

  /** 擦除已绘制的面板，光标回到面板起始行。 */
  private erase(): void {
    if (!this.isTTY || this.lastHeight === 0) return;
    this.out.write(`\x1b[${this.lastHeight}A\x1b[0J`);
    this.lastHeight = 0;
  }

  private render(): void {
    if (!this.isTTY) return;
    const lines = this.rows.map((r) => this.renderRow(r));
    // 非首帧：先回到上次绘制的开头并清屏到底
    if (this.lastHeight > 0) {
      this.out.write(`\x1b[${this.lastHeight}A\x1b[0J`);
    }
    this.out.write(lines.join('\n') + '\n');
    this.lastHeight = lines.length;
  }

  private renderRow(r: Row): string {
    const maxCols = Math.max(30, (this.out.columns ?? 100) - 4);
    const noteCols = Math.max(10, maxCols - displayWidth(r.label) - 12);
    switch (r.status) {
      case 'waiting':
        return `  ${c.dim(symbols.hourglass)} ${c.dim(r.label)}  ${c.dim('等待')}`;
      case 'running': {
        const spin = c.cyan(FRAMES[this.frame]);
        const elapsedMs = r.startedAt ? Date.now() - r.startedAt : 0;
        const elapsed = elapsedMs >= 1000 ? c.dim(` · +${Math.floor(elapsedMs / 1000)}s`) : '';
        return `  ${spin} ${c.cyan(r.label)}  ${c.gray('运行中')}${elapsed}`;
      }
      case 'ok': {
        const note = r.note ? '  ' + c.gray(truncateCols(r.note, noteCols)) : '';
        return `  ${c.green(symbols.check)} ${r.label}${note}`;
      }
      case 'failed': {
        const note = r.note ? '  ' + c.gray(truncateCols(r.note, noteCols)) : '';
        return `  ${c.red(symbols.cross)} ${c.red(r.label)}${note}`;
      }
    }
  }
}
