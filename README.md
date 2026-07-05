# LinAgent —— 从零实现的最小可用 Agent（Node + tsx）

不依赖任何 agent 框架（没有 langchain / langgraph / openhands / openclaw）。
就是一个 Node/TypeScript 写的 agent runtime，核心做的事：

- 用 JSON schema 注册工具；LLM 基于 schema 自主决策调哪个
- 每一轮让 LLM 决定是直接回答还是调工具，跑一个有边界的循环
- 每个"窗口"（session）的历史 + 状态**完全独立**
- 上下文超阈值时做**分层压缩**
- **跨会话记忆**分层存储 + 按需检索注入
- 高影响工具（fs 写 / delete / bash）走**交互式审批门**
- 附带 171 条 `node:test` 用例，全部离线、可复现

代码总量约 5000 行 src + 2500 行测试，零生产依赖（只有 `tsx` / `typescript` / `@types/node` 三个 devDep）。

---

## 上手

### 环境准备

```bash
cd LinAgent
npm install
cp .env.example .env    # 至少填 LLM_PROVIDER + LLM_API_KEY
```

`.env.example` 里列了 9 个 provider preset（`openai` / `anthropic` / `deepseek` / `moonshot` / `dashscope` / `zhipu` / `openrouter` / `groq` / `ollama`），选一个填 API key 即可跑。

### 两种运行方式

```bash
npm start              # v1 REPL —— while 循环版
npm run start:v2       # v2 REPL —— planner / executor 分离版

npm test               # 171 条离线测试（用 MockLLM，不打真接口）

# 让 v1 和 v2 用同一 LLM 跑同一个请求，对比 LLM 调用次数：
npx tsx scripts/compare.ts "帮我查一下北京的天气，然后把'带伞'加进待办"
```

### REPL 里可以用的命令（v1）

- `/new [标题]` — 新开一个会话（窗口）
- `/list` — 列出所有会话
- `/switch <id>` — 切换到指定会话
- `/rm <id>` — 删除某个会话（不能删当前）
- `/memory [list|forget <id>|clear]` — 查看/编辑跨会话记忆
- `/tokens` — 详细 token 用量柱状图（按类别）
- `/trace` — 打印当前会话的执行 trace
- `/reset` — 清空当前会话
- `/nostream` — 切换流式显示
- `/exit`

v2 REPL 命令基本相同（少了 `/memory`，因为 v2 目前没接跨会话记忆）。

---

## 存储位置

会话和记忆走**三级 fallback**：

1. `LINAGENT_HOME=<path>`（环境变量优先）
2. 当前工作目录里有 `.linagent/` → 就地用（**项目本地覆盖**）
3. 都没有 → 系统缓存目录
   - Windows: `%LOCALAPPDATA%\LinAgent\`
   - macOS: `~/Library/Caches/LinAgent/`
   - Linux: `$XDG_CACHE_HOME/LinAgent` 或 `~/.cache/LinAgent/`

REPL 启动时会打印一行 `存储: <path>  (系统缓存目录 | 项目本地 .linagent/ | LINAGENT_HOME)` 让你一眼看到用了哪条。

目录结构：
```
<LinAgent home>/
├── sessions/              ← v1 会话
├── sessions-v2/           ← v2 会话（独立存储，避免 schema 冲突）
└── memory/
    └── <userId>.json      ← 用户跨会话记忆
```

---

## 系统设计

### 一、v1 runtime：LLM-in-the-loop（[src/agent.ts](src/agent.ts)）

主循环每一轮 4 步：

1. **接收用户输入** → append 到 `session.history`
2. **决策** → 用 `[system prompt, ...history]` 调 LLM；输出是一个 JSON 对象，由 [parser.ts](src/llm/parser.ts) 解析成 `{ thought, action, tool?, final? }`
3. **调工具**（如果 `action == "tool_call"`）→ 走 [ToolRegistry.invoke](src/tools/registry.ts)；参数用工具自己的 JSON schema 校验；触碰高影响工具时走审批门
4. **继续 or 返回** → 工具结果作为 `role: 'tool'` 消息塞进历史；循环到 `final_answer` 或 `maxTurns` 熔断

**决策协议**是自定义的 JSON 对话协议 —— 不走 OpenAI 原生 `tools` 字段。好处是跨 provider 通用（同一份代码 DeepSeek/Moonshot/Claude/… 都能跑），代价是丢了 grammar-constrained decoding，所以要写 `parser.ts` 的 balanced-brace 扫描 + 错误回喂给模型自修。

### 二、v2 runtime：planner / executor 分离（[src/v2/](src/v2/)）

v1 是 while 循环 —— **每加一次工具调用就多一次 LLM completion**，独立工具没法并行，整个 trace 直到跑完之前都是黑盒。这是主流框架的通病，也是我做 v2 的动机。

v2 把这件事**拆成 4 块，只有 2 块跟 LLM 打交道**：

| 阶段 | 谁 | 做什么 |
| --- | --- | --- |
| **Planner** | LLM（1 次调用） | 输出一份 Plan JSON —— `tool` / `respond` 步骤组成的 DAG，带 `depends_on`、`expect`、`budget_ms` |
| **Verifier** | 代码 | 静态检查：schema、工具存在、DAG 无环、expect DSL 语法、总预算合规 |
| **Executor** | 代码 | 跑 DAG，能**并行**就并行，每步检查 `expect` 后置断言，emit span 树 |
| **Reflector** | LLM（仅失败时） | 读取失败步骤的 outcome，产出 PlanPatch 替换失败步骤及后续 |

后置断言用受限 DSL（`result.available == true`、`len(result.results) > 0`），由 runtime 解析求值 —— LLM 不生成、也不执行任何代码。`{{s1.result.city}}` 这类引用也由 runtime 在调用工具前解析掉。

**真接口数据**（跑 [scripts/compare.ts](scripts/compare.ts) 的 DeepSeek 结果）：

| 请求 | v1 LLM 调用 | v2 LLM 调用 | 减少 |
| --- | --- | --- | --- |
| "查北京天气 + 加一条待办"（2 步工具链） | 3 | 1 | −67% |
| "同时查 4 个城市天气找最热的"（4 并行 + 综合） | 5 | 2 | −60% |

**`respond.synthesize`** —— 静态模板搞不定的场景（比较、排序、跨结果推理），planner 可以在 respond 步骤上打 `synthesize: true`，executor 会触发一次小 LLM 调用综合结果。只在真需要时触发，节省 token。

### 三、工具（10 个，[src/tools/](src/tools/)）

每个工具都有 `name` / `description` / JSON schema，注册进 `ToolRegistry`。system prompt 每轮拼 `describeAll()` 让 LLM 看到全部工具。

| 工具 | 功能 | 需要审批 |
| --- | --- | --- |
| [`calculator`](src/tools/calculator.ts) | 安全的算术求值（调度场算法，禁用 `eval`） | |
| [`search`](src/tools/search.ts) | mock 知识库关键词检索 | |
| [`weather`](src/tools/weather.ts) | mock 天气查询（23 个中国主要城市 + 港澳台 + 常见海外），中英文城市名，°C/°F | |
| [`todo`](src/tools/todo.ts) | 增/查/完成/删除/清空 —— 数据挂在会话级 state 上，天然隔离 | |
| [`memory`](src/tools/memory.ts) | 读/写当前用户的跨会话记忆（详见下文） | |
| [`fs_read`](src/tools/fs.ts) | 读文本文件（≤ 512KB，默认全盘可读，可选沙盒） | |
| [`fs_list`](src/tools/fs.ts) | 列目录直接子项（不递归） | |
| [`fs_write`](src/tools/fs.ts) | 写/覆盖文件 | ✅ |
| [`fs_delete`](src/tools/fs.ts) | 删除文件（拒绝删目录） | ✅ |
| [`bash_exec`](src/tools/bash.ts) | 执行 shell 命令（默认 30s 超时，stdout/stderr 各 256KB 上限） | ✅ |

**审批门** —— 高影响工具（`RISKY_TOOLS`）每次调用都会弹一个交互式选择框（`↑/↓` 或 `j/k` 移动，`Enter` 确认，`y/a/n` 快捷键）：
- **允许一次** —— 这次放行，下次同工具还会问
- **本会话都允许** —— 加入白名单缓存到 `session.state.__approvedTools`（`string[]`，能 JSON 序列化，重启不炸）
- **拒绝** —— 把"用户拒绝"作为工具结果回喂给 LLM

**Fail-closed 语义**：`requireApproval` 里列了工具但 agent 没配 `approve` 回调 → 默认拒绝，绝不静默放行。

### 四、会话隔离（[src/session.ts](src/session.ts)）

`SessionManager` 按 id 存 session，每个 session 独占：
- `history: Message[]` —— 对话记录
- `state: Record<string, unknown>` —— 会话级状态（todo 列表挂在 `state.todos`，审批缓存挂在 `state.__approvedTools`）
- `trace: TraceEntry[]` —— 结构化执行日志

**跨窗口天然隔离**：todo 工具从数据结构上就不可能串（`ctx.sessionState.todos` 是 session-scope 的）。[test/session.test.ts](test/session.test.ts) + [test/agent.test.ts](test/agent.test.ts) 端到端覆盖。

**FileSessionStore** 落盘到 `<home>/sessions/<id>.json`（v2 走 `sessions-v2/`），重启进程自动恢复。

### 五、上下文管理（[src/context.ts](src/context.ts)）

**最大轮次**：`Agent.chat` 硬限 `AGENT_MAX_TURNS`（默认 32），触顶后返回兜底文本"已达 max turns 上限"。

**记住之前的状态**：`history` 挂在 session 上，跨 `chat()` 调用保留。追问（纯对话 or 带工具的）都能引用之前的用户输入 / assistant 输出 / 工具结果。测试覆盖："pure follow-up remembers prior turn state"、"follow-up with a new tool call reuses earlier context"。

**进上下文的内容**：
- 用户输入
- Assistant 的原始 JSON 回复（包含 thought，让模型能引用自己的推理）
- 工具结果：序列化成 `{ ok: true, result }` 或 `{ ok: false, error: {...} }`
- System prompt **每轮重建**（避免陈旧，也让 memory 注入能反映最新状态）

**基础压缩** —— 当 `history.length > maxMessages`（默认 24）时：
- 把最老那批消息（除最近 `keepRecent` = 8 条外）折进一条 `system` 角色的摘要
- 摘要用 [`llmSummarize`](src/context.ts)（走 LLM）或 [`heuristicSummarize`](src/context.ts) 兜底
- 摘要开头是"早期对话摘要："，用于类别识别（对应 token 统计里的 `summary` 类别）

**压缩触发点**（v1）：
1. 用户输入 → push 后
2. 每次工具调用完成 → push 后

（`final_answer` 之后不检查，下一轮开头会检查）

**v2 也接了压缩**（在 planner 调用之前压一次），跟 v1 走同一份 `compressIfNeeded`。

### 六、跨会话记忆（[src/memory.ts](src/memory.ts) + [src/extractor.ts](src/extractor.ts)）

**分层，不是平铺** —— 4 层各有独立的注入策略和冲突处理：

| 层 | 例子 | 注入策略 |
| --- | --- | --- |
| `identity` | "住在杭州"、"母语中文" | **每次都注入** |
| `preferences` | "回复用中文"、"省略客套话" | **每次都注入** |
| `facts` | "喜欢喝咖啡"、"用 macOS" | **按关键词 top-K 命中注入** |
| `ongoing` | "本周在读 SICP" | **按关键词 top-K 命中注入** |

#### 召回时机（Recall）—— 什么时候会去查记忆

只在**每轮 chat 的开头**（[src/agent.ts:132-142](src/agent.ts)），拼 system prompt 之前：

```
用户输入进入 → push('user_input') → maybeCompress → 从 memory store 加载用户 memory
                                                    ↓
                                        retrieveForQuery(mem, userInput, topK=5)
                                                    ↓
                                        formatForPrompt(命中的 facts)
                                                    ↓
                                        拼进 system prompt → 送 LLM
```

**只召回一次**，不在工具循环中重复召回。这是设计取舍：一轮内 LLM 已经知道相关 facts，重复拉取只会推高 token。

#### 放置方式（Injection）—— 记忆如何进入 LLM 上下文

不做 tool-based 检索（"agent 主动查记忆"），而是**在拼 system prompt 时静默注入**。system prompt 分两段：

```
<system>
[基础段] 工具 schema + 输出规则 + 角色约束
         （每次一样，走 prompt 缓存）

[记忆段] 关于本用户的已知信息（来自过往会话）:
         - identity:
             · 住在杭州
             · 母语中文
         - facts:
             · 喜欢喝咖啡      ← 与"咖啡"相关时才注入
</system>
```

**基础段和记忆段分开**是因为：
- 基础段稳定，可被 provider 缓存
- 记忆段每轮可能变（关键词命中不同的 facts）

Agent 内部记账把这两段分开传给 UI token 统计（[src/tokens.ts](src/tokens.ts)），所以 `/tokens` 命令能看到 `memory_facts` 单独一栏。

#### 冲突处理 —— 用户搬家了怎么办

`mergeCandidates` 走 Jaccard 相似度判定：

- **重复**（相似度 ≥ 0.85）→ 只刷新时间戳
- **矛盾**（extractor 显式 `contradicts` 提示 or identity/ongoing 层强重叠）→ 旧 fact 打上 `superseded_by`（**不删**，留审计链），新 fact 入库
- **加性**（facts / preferences 层的弱相似）→ 并存

#### 抽取时机（Ingest）—— 什么时候产生新记忆

每轮 chat 结束后，agent 把该轮的最后一条 user + 最后一条 assistant final answer 交给 [extractor.ts](src/extractor.ts)。抽取器是一个专用小 LLM 调用，让它产出符合 schema 的 `FactCandidate[]`：

- Bad JSON → 静默丢弃（fail-safe，不阻塞 chat）
- 好 candidates → `mergeCandidates` 合并进 store

**同步 ingest**，每轮多一次 LLM 调用；生产版应改成异步队列。

#### 用户可编辑

- Agent 通过 [memory 工具](src/tools/memory.ts) 可以 `list` / `add` / `forget`
- REPL 里 `/memory list`、`/memory forget <id>`、`/memory clear` 直接编辑
- 分词器走 latin 词 + CJK 单字混合，中英文 Jaccard 都能工作

#### v2 目前没接 memory

v2 REPL 演示的是 planner/executor 分离，跨会话记忆是正交能力 —— 想用记忆就跑 v1 REPL。

### 七、Token 统计（[src/tokens.ts](src/tokens.ts) + [src/ui/tokens.ts](src/ui/tokens.ts))

**本地启发式估算**，不做精确 tokenization：
- ASCII: ~4 字符/token
- CJK: ~1.4 字符/token
- 其它 Unicode: ~3 字符/token
- 每条消息 +4 token 结构开销

**分 6 类**统计：
- `system` —— 工具 schema + 角色约束
- `memory_facts` —— 记忆注入段
- `user` / `assistant` / `tool_result` —— 显然
- `summary` —— 压缩后的摘要（消息开头是"早期对话摘要"）

**每轮 chat 结束打印一行紧凑摘要**，`/tokens` 命令看完整柱状图。

### 八、异常处理 + Trace

**异常**：LLM HTTP 错误、JSON 解析错误、未知工具、参数校验错误、工具运行时错误全部捕获。Parse 错和参数错会**回喂给模型**让它在 `maxTurns` 之内自我修正。

**Trace**：每一步都记进 `session.trace`：
- `user_input` / `llm_response` / `tool_call` / `tool_result`
- `final` / `error` / `compress` / `memory`

支持 `hooks.onTrace` 回调让 UI 实时渲染。REPL 用 `/trace` 打完整 JSON。

---

## 目录结构

```
src/
  agent.ts              # v1 runtime 主循环
  session.ts            # SessionManager + FileSessionStore（落盘）
  context.ts            # compressIfNeeded + summarizer
  memory.ts             # 分层记忆存储 + 合并/冲突/检索
  extractor.ts          # LLM 抽取器：从对话尾部抽出 fact
  storage.ts            # 存储路径三级 fallback
  tokens.ts             # 本地 token 估算 + 分类统计
  types.ts              # 共享类型
  llm/
    client.ts           # OpenAI 兼容 + Anthropic 客户端（含 SSE 流式）
    parser.ts           # JSON 抽取 + AgentDecision
    prompt.ts           # v1 的 system prompt
    providers.ts        # provider preset 表（9 家）
  tools/
    registry.ts         # ToolRegistry + 参数校验 + RISKY_TOOLS 注册
    calculator.ts       # 调度场求值
    search.ts weather.ts todo.ts memory.ts
    fs.ts               # fs_read / fs_list / fs_write / fs_delete + 沙盒
    bash.ts             # bash_exec + 超时/输出上限
  v2/                   # planner / executor 分离实现
    plan.ts             # Plan / Step / PlanPatch 类型
    expect.ts           # 后置断言 DSL（安全 parser，禁用 eval）
    template.ts         # {{step_id.result.x}} 引用解析
    verifier.ts         # 静态校验
    executor.ts         # DAG 执行器，独立步骤自动并行，emit span 树
    planner.ts          # planner + reflector prompt + JSON 解析
    agent.ts            # V2Agent
  ui/
    ansi.ts width.ts spinner.ts render.ts prompt.ts tokens.ts v2-render.ts
  util/dotenv.ts        # 轻量 .env 加载器（无依赖）
  index.ts              # v1 REPL 入口
  index-v2.ts           # v2 REPL 入口
test/                   # 171 条离线测试（用 MockLLM）
  parser / tools / session / context / agent / persistence / streaming /
  providers / memory-* / v2-* / approval / storage / tokens / width /
  bash-tool / fs-tools / agent-hooks-trace 等
scripts/
  smoke.ts              # 用真实 LLM 跑一次 v1
  compare.ts            # v1 vs v2 同请求跑一遍看指标差
```

---

## 需求逐条对照

### 要求 1 —— 从零实现
Runtime 里没有任何 langgraph / openhands / openclaw 依赖。两个 LLM 客户端（[client.ts](src/llm/client.ts)）都是裸 `fetch` 打 OpenAI 兼容 / Anthropic 端点。

### 要求 2 —— 基本循环
- **4 步循环**：见"系统设计 § 一"
- **工具注册**：[ToolRegistry](src/tools/registry.ts) + JSON schema 校验，10 个工具（含 fs / bash）
- **LLM 输出解析**：[parser.ts](src/llm/parser.ts) balanced-brace 扫描 + 错误回喂
- **Session 独立**：见"系统设计 § 四"
- **最大轮次**：`maxTurns` 硬限 + 兜底
- **记住状态 + 追问**：history 全轮持久
- **上下文压缩**：见"系统设计 § 五"
- **异常 + Trace**：见"系统设计 § 八"

### 要求 3 —— 测试
`npm test` 跑 **171 条**离线测试，全部用 [MockLLM](test/mock-llm.ts)，不打真接口。

覆盖：parser、tools（每个工具 + schema 校验）、session（隔离）、context（压缩）、agent（完整循环 + 参数错自修 + JSON 错自修 + maxTurns 熔断 + 双会话隔离 + 追问 + 长对话压缩 + LLM 挂掉降级）、persistence（落盘恢复）、streaming（onDelta / onTurnStart / onTrace 回调）、providers（preset 表）、memory（core / extractor / tool / e2e）、v2（expect DSL / verifier / executor / agent / synthesize / 压缩 / approval）、approval（v1 5 条 + v2 3 条 + roundtrip 3 条）、tokens、width（CJK 显示）、fs / bash 工具、agent-hooks-trace 等。

---

## v2 —— planner / executor 分离的价值 & 短板

见"系统设计 § 二"。**LLM 调用减少 60-67%**（真接口数据）。

### 已修的短板
- ~~静态模板搞不定跨结果推理~~ → `respond.synthesize` 已实现
- ~~v2 没做上下文压缩~~ → 已接
- ~~v2 没审批门~~ → 已加

### 仍在的短板
- **Planner 输出走 JSON 而非 provider 原生 tool_use** —— 丢了 grammar-constrained decoding；未来接 v3 时把 Plan 打包成一个 `emit_plan` tool_use 就好
- **本地 token 估算精度约 ±10-20%** —— 用于 UI 显示够用，不精确，将来可以改成读 provider 响应里的 `usage` 字段
- **memory 检索用 keyword Jaccard 而非 embedding** —— 语义相近但关键词没重叠的场景会漏
- **memory ingest 是同步的** —— 每轮多一次 LLM 调用；生产版应改异步队列
- **v2 REPL 没接跨会话记忆** —— 想用记忆就跑 v1

---

## 一句话总结

**LinAgent 是一个从零实现的、能拿去讲清楚的 agent runtime**。作业题要求全部满足；工程细节（provider 预设 / UI / 流式 / 落盘 / token 统计 / 审批门 / 沙盒 / spinner）是加分项；planner-executor 分离和分层记忆是两块能拉开差距的架构主张，都有真接口数据 + 171 条测试证明。

对讲得开的短板都在 README 里主动列了 —— 面试聊哪一条深挖都行。
