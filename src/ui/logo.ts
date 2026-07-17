/**
 * 启动 logo —— 预渲染的 FIGlet「ANSI Shadow」字形，主体蓝色渐变。
 *
 * 字形是把 "LIN AGENT" 用 ANSI Shadow 字体（6 行高、带右下阴影的粗体块字）
 * 预渲染成固定文本，直接内置——零运行时依赖，也不用打包字体文件。
 * 上色走 ansi.ts 的 rgb()（真彩色，不支持时降级 256 色）；NO_COLOR / 非 TTY
 * 时退化成纯字形文本，不掺 ANSI 转义。
 */
import { rgb, colorEnabled, c } from './ansi.ts';

// ANSI Shadow 字体的 "LIN AGENT"（LIN 与 AGENT 之间空两格）。6 行。
// 每个字母都对照标准 ANSI Shadow 字形拼出，行尾有阴影 ▀▀ / ▝▀▀ 的收边。
// I 用带衬线（上下横帽 + 居中竖干）的字形，跟 ANSI Shadow 的 T 同款结构，
// 避免退化成一根难辨认的光竖条。L / N / AGENT 保持标准 ANSI Shadow 字形不变。
const LOGO_LINES: string[] = [
  '██╗     ██████╗███╗   ██╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗',
  '██║     ╚═██╔═╝████╗  ██║    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝',
  '██║       ██║  ██╔██╗ ██║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ',
  '██║       ██║  ██║╚██╗██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ',
  '███████╗██████╗██║ ╚████║    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ',
  '╚══════╝╚═════╝╚═╝  ╚═══╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ',
];

/** 蓝色科技渐变：从深钢蓝到亮青蓝，逐行提亮（6 行）。 */
const GRADIENT: [number, number, number][] = [
  [30, 80, 190],
  [45, 110, 220],
  [60, 145, 245],
  [80, 175, 255],
  [110, 205, 255],
  [150, 225, 255],
];

/** 生成启动 logo（含渐变上色）。 */
export function renderLogo(): string {
  if (!colorEnabled) return LOGO_LINES.join('\n');
  return LOGO_LINES.map((line, i) => rgb(...GRADIENT[i])(line)).join('\n');
}

/** logo 下方的一行副标题（暗蓝细体）。 */
export function logoTagline(): string {
  const text = 'a minimal-viable agent runtime · 最小可用智能体运行时';
  return colorEnabled ? c.dim(rgb(90, 140, 200)(text)) : text;
}

/** 供 Ink 组件用：原始字形行 + 每行 rgb 渐变色（Ink 用 <Text color="#rrggbb">）。 */
export const LOGO_ROWS: string[] = LOGO_LINES;
export const LOGO_GRADIENT_HEX: string[] = GRADIENT.map(
  ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''),
);
export const LOGO_TAGLINE = 'a minimal-viable agent runtime · 最小可用智能体运行时';
