import { c } from './ansi.ts';
import { displayWidth, truncateCols } from './width.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 单行滚动 spinner。
 *
 * - `start(label)`：开始转，label 是主标签。
 * - `update(label)`：不清零耗时，只换 label。
 * - `updateAndReset(label)`：换 label 并把耗时清零（换一个"新阶段"时用）。
 * - `stop()`：停下并擦掉本行。
 *
 * 每帧输出形如 `⠋ 主标签 · +3s`，耗时超过 1s 才显示，避免闪一下就消失。
 * 若 `process.stdout` 不是 TTY（管道/CI），完全静默，只保留 label 用于 stop 时清除。
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private i = 0;
  private label: string;
  private startedAt = 0;
  private active = false;
  private lastRenderLen = 0;

  constructor(label = 'thinking') {
    this.label = label;
  }

  start(label?: string): void {
    if (label !== undefined) this.label = label;
    if (!process.stdout.isTTY) return;
    if (this.active) return;
    this.active = true;
    this.i = 0;
    this.startedAt = Date.now();
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  /** 换 label；耗时继续累加（"我还在做同一件事，只是换个说法"）。 */
  update(label: string): void {
    this.label = label;
    if (this.active) this.render();
  }

  /** 换 label 并把耗时清零（"这是新阶段"）。 */
  updateAndReset(label: string): void {
    this.label = label;
    this.startedAt = Date.now();
    if (this.active) this.render();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (process.stdout.isTTY) {
      process.stdout.write('\r' + ' '.repeat(this.lastRenderLen) + '\r');
    }
    this.lastRenderLen = 0;
  }

  private render(): void {
    const frame = FRAMES[this.i = (this.i + 1) % FRAMES.length];
    const elapsedMs = Date.now() - this.startedAt;
    const elapsed = elapsedMs >= 1000 ? c.dim(` · +${Math.floor(elapsedMs / 1000)}s`) : '';
    // 终端太窄时截断 label，避免整行超出后回车错乱
    const maxCols = Math.max(20, (process.stdout.columns ?? 100) - 12);
    const shownLabel = truncateCols(this.label, maxCols);
    const line = `${c.cyan(frame)} ${c.dim(shownLabel)}${elapsed}`;
    // 先清掉上一次残留（按上次的宽度补空格）
    if (process.stdout.isTTY) {
      process.stdout.write('\r' + ' '.repeat(this.lastRenderLen) + '\r' + line);
    }
    this.lastRenderLen = displayWidth(line);
  }
}
