/**
 * 内置 preset 库 —— 4 份高质量账本示例。
 *
 * 每份 preset 由三部分决定它会被选中：
 *   - intent_keywords    匹配当前会话 core.intent + 最近 user 输入
 *   - custom_namespaces  匹配当前账本已经出现的自定义命名空间
 *   - example            被选中后作为 few-shot 塞进 system prompt
 *
 * 关键约束：**preset 只是"给 LLM 看的参考"，不是"必须遵守的模板"**。
 * system prompt 里明确告诉 LLM 可以自由发明适合的命名空间。
 *
 * default preset 是兜底 —— 没有其它 preset 命中时用它，保证 few-shot 段总有内容。
 */

import type { Preset } from './types.ts';

// ── helper 造一份最小的 preset example ledger ─────────────────────────
function exampleLedger(
  intent: string,
  suggested: Partial<Preset['example']['suggested']>,
  custom: Preset['example']['custom'] = {},
): Preset['example'] {
  return {
    version: 1,
    session_id: '<example>',
    created_at: 0,
    updated_at: 0,
    turn_count: 12,
    core: { intent, state: 'wrapping', language: 'zh' },
    suggested,
    custom,
    next_item_id: 100,
  };
}

// ── 4 份内置 preset ───────────────────────────────────────────────────

export const DEFAULT_PRESET: Preset = {
  name: 'default',
  description: '默认账本骨架 —— 适用于任何类型的会话',
  intent_keywords: [],   // 关键词空 = 永不"主动匹配"，只作为兜底
  custom_namespaces: [],
  example: exampleLedger('（一句话讲你在做什么）', {
    findings: [
      { id: 'f1', text: '（一条你觉得值得跨轮引用的结论）', created_turn: 3 },
    ],
    open_threads: [
      { id: 'o1', text: '（一个还没闭合的线头）', created_turn: 5, status: 'wip' },
    ],
  }),
};

const DEBUG_PRESET: Preset = {
  name: 'debug',
  description: '排错/诊断类会话 —— 重点是保留因果链而非过程',
  intent_keywords: ['为什么', '报错', '异常', '不对', '挂了', '崩', 'bug', 'error', 'debug', '排查', '定位', '诊断', '修复'],
  custom_namespaces: ['debug'],
  example: exampleLedger('排查 npm test 挂在 auth.test.ts 的问题', {
    findings: [
      { id: 'f1', text: 'jest 报 "timeout of 5000ms exceeded"', created_turn: 2 },
      { id: 'f2', text: 'setup hook 在 db.connect 处永远 pending', created_turn: 5 },
    ],
    decisions: [
      { id: 'd1', text: '在 CI 上把 db mock 掉，不连真库', created_turn: 8 },
    ],
  }, {
    'debug.causal_chain': [
      { id: 'c1', text: 'test 超时 → setup hook 卡住 → db.connect 无 timeout → 网络无法直达 CI 里的开发库',
        created_turn: 7,
        meta: { severity: 'high' } },
    ],
  }),
};

const EXECUTION_PRESET: Preset = {
  name: 'execution',
  description: '执行/操作类任务 —— 重点是保留已完成动作和产物',
  intent_keywords: ['帮我', '部署', '运行', '安装', '配置', '设置', '构建', 'build', 'run', 'deploy', 'install', 'setup'],
  custom_namespaces: [],
  example: exampleLedger('把项目部署到 staging', {
    progress: [
      { id: 'p1', text: 'npm build（tsconfig target=ES2022）',   created_turn: 3, status: 'done' },
      { id: 'p2', text: 'npm test (47 passed)',                  created_turn: 5, status: 'done' },
      { id: 'p3', text: '推送到 staging',                          created_turn: 9, status: 'wip' },
    ],
    artifacts: [
      { id: 'a1', text: 'tsconfig.json (modified: target)',      created_turn: 3 },
      { id: 'a2', text: '.github/workflows/deploy.yml (edited)', created_turn: 8 },
    ],
    open_threads: [
      { id: 'o1', text: 'CI deploy secret 待配', created_turn: 7, status: 'wip' },
    ],
  }),
};

const BRAINSTORM_PRESET: Preset = {
  name: 'brainstorm',
  description: '头脑风暴/发散讨论 —— 重点是保留观点链和决策，砍掉推理过程',
  // 关键词保守取，避免过泛的口语词（'怎么'/'好吗'/'你觉得' 几乎会命中任何自然语言输入）。
  intent_keywords: ['我在想', '想聊聊', '发散', '头脑风暴', '讨论一下', '设计一下', '思路', 'brainstorm'],
  custom_namespaces: ['brainstorm'],
  example: exampleLedger('设计一套新的智能体记忆机制', {
    findings: [
      { id: 'f1', text: '业界普遍做法都是通用摘要，粒度太粗', created_turn: 2 },
      { id: 'f2', text: '压缩谱系（情景→技能→规则）是缺失的对角线', created_turn: 6 },
    ],
    decisions: [
      { id: 'd1', text: '账本机制优于事后摘要，因为边干边填不需要事后猜',    created_turn: 9 },
      { id: 'd2', text: '分类学从 custom 命名空间涌现，而不是设计者定死',    created_turn: 11 },
    ],
  }, {
    'brainstorm.rejected': [
      { id: 'r1', text: '硬编码 6 类会话类型 —— 太刚性，不允许 agent 自涌现', created_turn: 10 },
    ],
  }),
};

/**
 * 所有内置 preset。
 * default 的兜底靠 pickPreset 里 `presets.find(p => p.name === 'default')` 显式挑，
 * 跟这个数组的顺序无关 —— 位置随便放都行。
 */
export const BUILTIN_PRESETS: Preset[] = [
  DEBUG_PRESET,
  EXECUTION_PRESET,
  BRAINSTORM_PRESET,
  DEFAULT_PRESET,
];
