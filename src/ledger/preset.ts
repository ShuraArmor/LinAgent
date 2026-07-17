/**
 * Preset 选择器 —— 决定当前会话该用哪份 preset 作为 few-shot。
 *
 * 调用时机：**会话首轮** freeze system prompt 时选一次，选定后整会话冻结不变（保 provider
 * 前缀缓存，见 agent.ts freezeSystemPrompt）。选择用首轮真实用户输入 + 账本 intent 做匹配 ——
 * 这是账本"自演化对话类型"的入口（排错→debug preset、执行→execution preset…）。
 * 实现仍保持便宜、纯函数、无 IO（磁盘那份 preset 库单独一次加载）。
 *
 * 历史：早期设计（B2）是"每轮都可能切 preset"；冻结重构后改为首轮定型，避免每轮换 few-shot
 * 破坏缓存。preset 只影响 few-shot 引导，不影响账本本身。
 *
 * 打分维度：
 *   - intent_keywords 命中：每命中一个词 +2 分
 *   - custom_namespaces 交集：每有一个共同命名空间 +5 分（信号更强）
 *   - default preset 永远拿 0.5 分兜底 —— 无其它命中时它赢
 *
 * 关键：**切 preset 只影响 few-shot 内容，不影响账本本身**。所以 preset 抖动无害。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Preset, Ledger } from './types.ts';
import { BUILTIN_PRESETS, DEFAULT_PRESET } from './presets.ts';

/** 单份 preset 文件的字节上限（超过就 skip，避免误放的大文件撑爆启动）。 */
const PRESET_MAX_BYTES = 512 * 1024;
/** loadPresetsFromDir 一次最多加载的文件数 —— 目录里几千个文件不该拖慢启动。 */
const PRESET_MAX_FILES = 100;
/** preset.intent_keywords / custom_namespaces 数组的长度上限。 */
const PRESET_MAX_KEYWORDS = 64;
/** 单个关键词字符长度上限。 */
const PRESET_MAX_KEYWORD_LEN = 100;
/** example ledger 序列化后的字节上限（超过 skip 整份 preset）。 */
const PRESET_MAX_EXAMPLE_BYTES = 16 * 1024;

export interface PresetSelection {
  preset: Preset;
  score: number;
  reason: string;    // "命中关键词 debug/报错" 或 "custom namespace 交集 debug" 等
}

/**
 * 从一组 preset 里挑最匹配当前账本 + 用户输入的那一份。
 * 保证总有返回值 —— 至少返回 default preset。
 */
export function pickPreset(
  ledger: Ledger,
  userInput: string,
  presets: Preset[] = BUILTIN_PRESETS,
): PresetSelection {
  // 用户输入超长时（比如粘贴几百 KB 日志）只用前 4096 字符做关键词匹配 —— 关键词匹配用
  // 更长的文本没有意义，还会拖慢 pickPreset。
  const rawUserInput = typeof userInput === 'string' ? userInput.slice(0, 4096) : '';
  const query = `${ledger.core.intent}\n${rawUserInput}`.toLowerCase();
  const activeCustomNs = new Set(
    Object.keys(ledger.custom).map((k) => k.split('.')[0]),
  );

  // 兜底 preset：优先从传入的 presets 里找同名的 default，找不到才退回内置 DEFAULT_PRESET。
  // 这样用户通过 mergePresets 覆盖 default 时能真正命中用户版。
  const fallback = presets.find((p) => p.name === 'default') ?? DEFAULT_PRESET;
  let best: PresetSelection = { preset: fallback, score: 0.5, reason: '兜底 default' };

  for (const p of presets) {
    let score = 0;
    const hits: string[] = [];

    // intent 关键词命中：每命中一个 +2。加类型守卫，坏 preset 不能拖垮整轮 chat。
    for (const kw of p.intent_keywords ?? []) {
      if (typeof kw !== 'string' || !kw) continue;
      if (query.includes(kw.toLowerCase())) {
        score += 2;
        hits.push(`kw:${kw}`);
      }
    }

    // custom namespace 交集：每一个共同的 +5（更强信号）
    for (const ns of p.custom_namespaces ?? []) {
      if (typeof ns !== 'string' || !ns) continue;
      if (activeCustomNs.has(ns)) {
        score += 5;
        hits.push(`ns:${ns}`);
      }
    }

    // default preset 在无命中时仍然拿 0.5 兜底分（这里 fallback 已经从传入 presets 里挑过）
    if (p.name === 'default' && score === 0) score = 0.5;

    // 严格大于 —— 同分保留先遍历到的。default 已经作为初始 best 拿了 0.5，
    // 所以只有真正拿到 ≥ 1 分（命中过至少一个关键词/namespace）才会替代它。
    if (score > best.score) {
      best = {
        preset: p,
        score,
        reason: hits.length ? hits.join(', ') : '兜底 default',
      };
    }
  }

  return best;
}

/**
 * 用户自定义 preset 合入内置库。用户 preset 优先级更高（顺序在前）。
 * name 冲突时用户覆盖内置。
 */
export function mergePresets(userPresets: Preset[], builtins: Preset[] = BUILTIN_PRESETS): Preset[] {
  const userNames = new Set(userPresets.map((p) => p.name));
  const filtered = builtins.filter((p) => !userNames.has(p.name));
  return [...userPresets, ...filtered];
}

/**
 * 从磁盘目录加载 preset。**严格校验 + fail-safe**：
 *   - dir 不存在 or 不是目录 → 空数组
 *   - 单文件 > 512KB → skip（防误放大文件撑爆启动）
 *   - 目录里 > 100 个 .json → 只加载前 100 个
 *   - 校验失败 or JSON 解析失败 → skip 该文件（不 throw）
 *
 * 校验规则见 isValidPreset。
 */
export function loadPresetsFromDir(dir: string): Preset[] {
  let entries: string[];
  try {
    const s = statSync(dir);
    if (!s.isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Preset[] = [];
  let scanned = 0;
  for (const name of entries) {
    if (scanned >= PRESET_MAX_FILES) break;
    if (!name.endsWith('.json')) continue;
    scanned += 1;
    const path = join(dir, name);
    try {
      const sizeOk = statSync(path).size <= PRESET_MAX_BYTES;
      if (!sizeOk) continue;
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizePresetShape(parsed);
      if (!normalized) continue;
      // example 大小上限：巨型 example 每轮拼进 system prompt 会持续伤害。
      if (JSON.stringify(normalized.example).length > PRESET_MAX_EXAMPLE_BYTES) continue;
      out.push(normalized);
    } catch {
      // 静默跳过坏文件 —— 用户的 preset 文件不该炸 REPL
    }
  }
  return out;
}

/**
 * 校验并规范化 preset 结构。返回 null 表示不合法。
 * 关键：非字符串关键词被 filter 掉、超长关键词被截断，让 pickPreset 拿到干净数据。
 */
function normalizePresetShape(raw: unknown): Preset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;

  // name 必须非空字符串
  if (typeof p.name !== 'string' || !p.name.trim()) return null;

  // example.core 必须存在且 intent 是字符串
  const example = p.example as Record<string, unknown> | undefined;
  if (!example || typeof example !== 'object') return null;
  const core = example.core as Record<string, unknown> | undefined;
  if (!core || typeof core.intent !== 'string') return null;

  // suggested / custom 若存在必须是对象
  if (example.suggested !== undefined && (typeof example.suggested !== 'object' || Array.isArray(example.suggested))) {
    return null;
  }
  if (example.custom !== undefined && (typeof example.custom !== 'object' || Array.isArray(example.custom))) {
    return null;
  }

  // 关键词数组规范化 —— 只保留有效字符串，截长度
  const cleanKws = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= PRESET_MAX_KEYWORD_LEN)
      .slice(0, PRESET_MAX_KEYWORDS);
  };

  return {
    name: p.name.trim(),
    description: typeof p.description === 'string' ? p.description : '',
    intent_keywords: cleanKws(p.intent_keywords),
    custom_namespaces: cleanKws(p.custom_namespaces),
    example: {
      ...(example as unknown as Preset['example']),
      suggested: (example.suggested as Preset['example']['suggested']) ?? {},
      custom: (example.custom as Preset['example']['custom']) ?? {},
    },
  };
}
