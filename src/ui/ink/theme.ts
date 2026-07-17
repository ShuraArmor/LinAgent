/**
 * TUI 配色主题 —— 单一事实来源。
 *
 * 设计原则：
 *   - 用户 vs 智能体用一对高区分度、又都落在既有调色板里的颜色包边：
 *       · 用户   = 柔紫 magenta（沿用现有 用户›/plan 标签的 magenta 家族）
 *       · 智能体 = 青蓝 cyan（呼应 logo 蓝渐变 + assistant 文本的 cyanBright）
 *     二者近互补，一眼能分清谁在说话。
 *   - 每个工具有独立的图标 + 颜色，按语义分组：
 *       读取/信息类 → 蓝；计算 → 青；todo → 绿；记忆/账本 → 紫；
 *       高影响(risky：写/删/bash/workflow) → 暖橙红（视觉预警）；
 *       skill → 黄；后台任务 → 浅蓝。
 */

/** 会话双方 + 若干功能段的边框/强调色。 */
export const COLORS = {
  /** 用户消息边框（柔紫）。 */
  userBorder: '#c586e0',
  /** 用户标签强调。 */
  userAccent: '#dcacf0',
  /** 智能体消息边框（青蓝）。 */
  agentBorder: '#3fb9d6',
  /** 智能体标签/流式光标强调。 */
  agentAccent: '#7fd6ea',
  /** 思考（thinking）段——暗蓝灰，视觉次要。 */
  thinking: '#8a8fb0',
} as const;

/** 工具运行中动画的 spinner 帧（与 StatusBar 同款 braille）。 */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export interface ToolTheme {
  /** 展示图标。 */
  icon: string;
  /** 该工具的主色（Ink 十六进制色）。 */
  color: string;
  /** 是否高影响工具（写/删/执行类）——UI 上给暖色预警。 */
  risky?: boolean;
}

/** 缺省主题（未登记的工具，含 MCP 桥接进来的动态工具）。 */
const DEFAULT_TOOL: ToolTheme = { icon: '🔧', color: '#e5c07b' };

/**
 * 工具 → 主题。key 是工具 name。
 * 未在此表中的工具（如 MCP 动态工具）走 DEFAULT_TOOL。
 */
export const TOOL_THEMES: Record<string, ToolTheme> = {
  // ── 信息 / 读取类（蓝） ──
  weather:        { icon: '🌦', color: '#5dade2' },
  search:         { icon: '🔍', color: '#5499c7' },
  fs_read:        { icon: '📄', color: '#7fb3d5' },
  fs_list:        { icon: '📁', color: '#7fb3d5' },
  recall_archive: { icon: '📼', color: '#5dade2' },

  // ── 计算 ──
  calculator:     { icon: '🧮', color: '#48c9b0' },

  // ── todo（绿） ──
  todo:           { icon: '📝', color: '#58d68d' },

  // ── 记忆 / 账本（紫） ──
  memory:         { icon: '🧠', color: '#af7ac5' },
  update_ledger:  { icon: '📒', color: '#bb8fce' },

  // ── skill（黄） ──
  load_skill:     { icon: '⚡', color: '#f7dc6f' },
  list_skills:    { icon: '⚡', color: '#f7dc6f' },
  create_skill:   { icon: '🛠', color: '#f4d03f' },

  // ── 后台任务（浅蓝） ──
  spawn_task:     { icon: '⏳', color: '#85c1e9' },
  check_task:     { icon: '⏳', color: '#85c1e9' },
  list_tasks:     { icon: '⏳', color: '#85c1e9' },
  cancel_task:    { icon: '🛑', color: '#ec7063', risky: true },

  // ── 高影响工具（暖橙红，risky） ──
  fs_write:       { icon: '✏️', color: '#e59866', risky: true },
  fs_delete:      { icon: '🗑', color: '#ec7063', risky: true },
  bash_exec:      { icon: '💻', color: '#f0a35e', risky: true },
  run_workflow:   { icon: '🔀', color: '#f5b041', risky: true },
};

/** 取某工具的主题；未登记则返回缺省。 */
export function toolTheme(name: string): ToolTheme {
  return TOOL_THEMES[name] ?? DEFAULT_TOOL;
}
