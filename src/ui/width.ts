/**
 * 计算字符串在终端里占的"列数"（不是 char 数），并按列宽做 pad / wrap。
 *
 * 主要用于让含中文的行框（finalBox、sessionRow、approval prompt 等）不错位。
 * 规则：
 *   - CJK 汉字、假名、韩文、以及大多数全角标点 → 2 列
 *   - 零宽字符（ZWJ / ZWNJ / VS16 等） → 0 列
 *   - 其它字符 → 1 列
 *   - 会先把 ANSI 转义序列剥掉，防止转义码计入宽度
 */

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** 剥掉 ANSI 转义序列。 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 单个码点占几列。 */
function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // 零宽 / 组合标记 / VS16 / ZWJ 等
  if (
    (cp >= 0x0300 && cp <= 0x036F) ||         // combining diacritical
    (cp >= 0x200B && cp <= 0x200F) ||         // zero-width space / joiner / marks
    cp === 0xFEFF ||
    cp === 0x2028 || cp === 0x2029 ||
    (cp >= 0xFE00 && cp <= 0xFE0F)            // variation selectors
  ) return 0;
  // 常见"宽"字符范围：CJK 统一表意 + 扩展 + 假名 + 韩文 + 全角标点 + Emoji 常用块
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||         // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||         // CJK 部首 & 标点
    (cp >= 0x3041 && cp <= 0x33FF) ||         // 假名 / 兼容 / 韩文
    (cp >= 0x3400 && cp <= 0x4DBF) ||         // CJK 扩展 A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||         // CJK 基本
    (cp >= 0xA000 && cp <= 0xA4CF) ||         // 彝文等
    (cp >= 0xAC00 && cp <= 0xD7A3) ||         // 韩文音节
    (cp >= 0xF900 && cp <= 0xFAFF) ||         // CJK 兼容表意
    (cp >= 0xFE30 && cp <= 0xFE4F) ||         // CJK 兼容形式
    (cp >= 0xFF00 && cp <= 0xFF60) ||         // 全角 ASCII
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||         // 全角符号
    (cp >= 0x1F300 && cp <= 0x1F64F) ||       // Emoji 常用块
    (cp >= 0x1F900 && cp <= 0x1F9FF)          // 补充符号 & pictographs
  ) return 2;
  return 1;
}

/** 计算字符串的显示列数（先剥 ANSI）。 */
export function displayWidth(s: string): number {
  const bare = stripAnsi(s);
  let w = 0;
  for (const ch of bare) {
    // 用 for..of 拿到完整码点（surrogate pair 会自动合并）
    w += codePointWidth(ch.codePointAt(0)!);
  }
  return w;
}

/** 按显示列数右侧补空格到 target 宽度。 */
export function padEndCols(s: string, target: number, fill = ' '): string {
  const cur = displayWidth(s);
  if (cur >= target) return s;
  return s + fill.repeat(target - cur);
}

/** 按显示列数左侧补空格到 target 宽度。 */
export function padStartCols(s: string, target: number, fill = ' '): string {
  const cur = displayWidth(s);
  if (cur >= target) return s;
  return fill.repeat(target - cur) + s;
}

/** 按显示列数硬截断（不考虑 ANSI 保护 —— 只用在 ANSI-free 文本上）。 */
export function truncateCols(s: string, maxCols: number, ellipsis = '…'): string {
  if (displayWidth(s) <= maxCols) return s;
  const ellW = displayWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = codePointWidth(ch.codePointAt(0)!);
    if (w + cw + ellW > maxCols) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/**
 * 按显示列数把一行文本硬切成多行（不做词边界分析，简单可靠）。
 * 输入不应包含 ANSI（调用方负责保证）。
 */
export function wrapCols(s: string, maxCols: number): string[] {
  if (maxCols <= 0) return [s];
  const out: string[] = [];
  let cur = '';
  let w = 0;
  for (const ch of s) {
    const cw = codePointWidth(ch.codePointAt(0)!);
    if (w + cw > maxCols) {
      out.push(cur);
      cur = ch;
      w = cw;
    } else {
      cur += ch;
      w += cw;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
