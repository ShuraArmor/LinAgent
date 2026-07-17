/**
 * Session Ledger —— 会话账本
 *
 * 一份账本是由 LLM 边干边填的、结构化的会话档案。
 * 三层组织：
 *   1. core          —— 通用核，每个会话都有的最小契约（intent/state/language）
 *   2. suggested     —— 推荐槽位，LLM 按需填，不填就不占 token
 *   3. custom        —— LLM 自己发明的命名空间，key 格式 "<ns>.<field>"
 *
 * 分类学从 custom 里涌现 —— 不是设计者提前把 6 类硬编码，而是通过统计 custom
 * 里高频出现的 namespace 组合，让"debug"/"editing"/"refactor"这些概念自然长出来。
 *
 * 账本独立于 session 存储在 <home>/ledgers/<sessionId>.json，好处是 emergence 分析
 * 可以扫全库账本而不用加载 session 的完整 history。
 */

/** 每个 LedgerItem 都是一条可引用的、可 patch 定位的条目。 */
export interface LedgerItem {
  /** runtime 分配的短 id（f1 / t2 / d3 ...），LLM 不允许自己起。 */
  id: string;
  /** 主体文本 —— 一句话陈述这条条目在讲什么。 */
  text: string;
  /** 自由取值的状态字段（"done" / "wip" / "resolved" 等）。 */
  status?: string;
  /** 关联的原始消息 id 列表；压缩归档后仍能追溯证据。 */
  evidence?: string[];
  /** 若关联消息已归档，指向归档段（如 "@seg17"）。压缩机制才会填。 */
  archived_ref?: string;
  /** 该条目首次创建的 turn 号。 */
  created_turn: number;
  /** agent 想附加的任意小元数据（键值都是字符串，方便序列化）。 */
  meta?: Record<string, string>;
}

/** 通用核 —— 每个账本的最小契约。 */
export interface LedgerCore {
  /** 会话目标，一句话。空账本时是空串，LLM 应尽快填。 */
  intent: string;
  /** 会话生命周期状态。 */
  state: 'active' | 'wrapping' | 'closed';
  /** 主要语言（"zh" / "en" ...），影响 extractor 生成候选事实的语言。 */
  language: string;
}

/** 推荐槽位 —— 都是可选，LLM 只填它认为适用的。 */
export interface LedgerSuggested {
  /** 已推进的事（步骤、动作）。 */
  progress?: LedgerItem[];
  /** 发现的结论、事实、观察。 */
  findings?: LedgerItem[];
  /** 做过的决定或选择。 */
  decisions?: LedgerItem[];
  /** 未闭合的线头（还有事没做完）。 */
  open_threads?: LedgerItem[];
  /** 卡住的地方（等待外部/资源不足）。 */
  blockers?: LedgerItem[];
  /** 产生的文件/产物。 */
  artifacts?: LedgerItem[];
}

/**
 * 一份完整账本。
 * 序列化到 <home>/ledgers/<sessionId>.json。
 */
export interface Ledger {
  version: 1;
  session_id: string;
  created_at: number;
  updated_at: number;
  /** 上次 patch 时的 turn 号；用于展示"账本已多少轮没动"。 */
  turn_count: number;
  /** 本轮 chat 使用的 preset 名（可能每次切换）。 */
  preset_used?: string;

  core: LedgerCore;
  suggested: LedgerSuggested;

  /**
   * 自定义命名空间。
   * key 格式：<namespace>.<field>，如 "debug.causal_chain" / "editing.final_version"。
   * namespace 与 field 都必须匹配 /^[a-z][a-z0-9_]*$/。
   */
  custom: Record<string, LedgerItem[]>;

  /** 下一个可用的 item id 序号（runtime 分配 id 时递增）。 */
  next_item_id: number;
}

/**
 * LLM 输出的账本补丁。基于 RFC 6902 的三个核心 op（add / replace / remove），
 * 但 path 用点号分隔（比 JSON Pointer 更适合 LLM 输出）。
 *
 * 路径语法：
 *   core.intent                              → 定位 core.intent 字段
 *   core.state                               → 同上
 *   suggested.findings                       → 定位 findings 数组本身
 *   suggested.findings[f3]                   → 定位 findings 里 id=f3 的条目
 *   suggested.findings[f3].status            → 定位该条目的 status 字段
 *   custom.debug.causal_chain                → 定位 custom namespace（首次 add 会自动创建）
 *   custom.debug.causal_chain[c1]            → 定位其中一条
 *
 * op 语义：
 *   add     —— 目标是数组：追加一条（value 是 { text, status?, meta? }，id 由 runtime 分配）
 *            —— 目标是字段：设为该值（等价于 replace）
 *   replace —— 目标必须存在，覆盖为 value
 *   remove  —— 目标必须存在，删掉；数组条目按 id 删除
 */
export interface LedgerPatch {
  op: 'add' | 'replace' | 'remove';
  path: string;
  /** remove 时 value 无意义。 */
  value?: unknown;
}

/** patch 应用报告。 */
export interface PatchReport {
  applied: LedgerPatch[];
  /** 应用失败的 patch + 失败原因；调用方通常记 trace 但不阻塞主流程。 */
  failed: Array<{ patch: LedgerPatch; error: string }>;
  /** runtime 为 add 操作分配的 item id 列表（跟 applied 顺序对齐；非 add 的位置是 null）。 */
  assigned_ids: (string | null)[];
}

/**
 * Preset —— 一份高质量账本作为 few-shot 示例。
 * 系统 prompt 里会挑一份最相关的 preset 塞进去当参考，但不强制 LLM 按它填。
 */
export interface Preset {
  name: string;
  description: string;
  /** 匹配当前会话时用到的关键词（在 core.intent / user 输入里搜）。 */
  intent_keywords?: string[];
  /** 该 preset 惯用的 custom namespace（用于 emergence 阶段的匹配打分）。 */
  custom_namespaces?: string[];
  /** 完整的账本示例，会被序列化后插进 system prompt 作为 few-shot。 */
  example: Ledger;
}
