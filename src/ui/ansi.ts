/** Tiny hand-rolled ANSI style helpers. No deps. Auto-disables when stdout isn't a TTY or NO_COLOR is set. */

const enabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

function wrap(open: number, close: number) {
  return (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

/**
 * 是否支持真彩色（24-bit）。COLORTERM=truecolor/24bit 是通行信号；
 * Windows Terminal / 现代终端普遍支持。拿不准时返回 false，走 256 色兜底。
 */
const truecolor = (() => {
  if (!enabled) return false;
  const ct = process.env.COLORTERM;
  return ct === 'truecolor' || ct === '24bit';
})();

/** 24-bit 前景色。终端不支持真彩色时降级到最接近的 256 色。 */
export function rgb(r: number, g: number, b: number): (s: string) => string {
  if (!enabled) return (s: string) => s;
  const seq = truecolor
    ? `\x1b[38;2;${r};${g};${b}m`
    : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
  return (s: string) => `${seq}${s}\x1b[39m`;
}

/** 把 rgb 映射到 xterm-256 的 6×6×6 色立方（16..231）。 */
function rgbTo256(r: number, g: number, b: number): number {
  const q = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  reset: (s: string) => (enabled ? `\x1b[0m${s}\x1b[0m` : s),

  black: wrap(30, 39),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),

  bgBlue: wrap(44, 49),
  bgMagenta: wrap(45, 49),
};

/** 供 logo 等模块判断要不要上色。 */
export const colorEnabled = enabled;

export const symbols = {
  arrow: '›',
  bullet: '•',
  check: '✓',
  cross: '✗',
  gear: '⚙',
  brain: '🧠',
  wrench: '🔧',
  sparkles: '✨',
  hourglass: '⏳',
  info: 'ℹ',
};

export function hr(width = 60, ch = '─'): string {
  return c.gray(ch.repeat(width));
}

export function box(title: string, body: string, tint: (s: string) => string = c.cyan): string {
  const w = Math.max(...body.split('\n').map((l) => stripAnsi(l).length), stripAnsi(title).length) + 2;
  const top = tint(`┌─ ${title} ${'─'.repeat(Math.max(0, w - stripAnsi(title).length - 3))}┐`);
  const bot = tint(`└${'─'.repeat(w + 2)}┘`);
  const middle = body
    .split('\n')
    .map((l) => tint('│ ') + l + ' '.repeat(Math.max(0, w - stripAnsi(l).length - 1)) + tint('│'))
    .join('\n');
  return `${top}\n${middle}\n${bot}`;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export function truncate(s: string, n: number): string {
  const raw = stripAnsi(s);
  if (raw.length <= n) return s;
  return s.slice(0, n) + c.dim('…');
}
