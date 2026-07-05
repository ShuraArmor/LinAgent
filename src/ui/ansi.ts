/** Tiny hand-rolled ANSI style helpers. No deps. Auto-disables when stdout isn't a TTY or NO_COLOR is set. */

const enabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

function wrap(open: number, close: number) {
  return (s: string): string => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
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
