```
██╗     ██╗███╗   ██╗     █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██║     ██║████╗  ██║    ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
██║     ██║██╔██╗ ██║    ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██║     ██║██║╚██╗██║    ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
███████╗██║██║ ╚████║    ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
╚══════╝╚═╝╚═╝  ╚═══╝    ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
```

# LinAgent

> a minimal-viable agent runtime · 最小可用智能体运行时

从零手写的 Agent 运行时（Node + TypeScript + Ink TUI），**不依赖任何 agent 框架**
（没有 langchain / langgraph / openhands）。生产依赖只有 `react` / `ink` / `commander`
三个——核心的 agent 循环、LLM 客户端、工具系统、记忆、压缩全是自己实现的。

一句话：一个能在终端里跑的、带持久记忆和上下文压缩的多 provider Agent。

## 核心特性

- **原生工具调用**——用 JSON schema 注册工具，走 provider 原生 `tools` 协议（OpenAI / Anthropic 两套），LLM 自主决策调哪个。
- **两种决策模式，同一个 agent**——`loop`（经典 ReAct，边想边做）与 `plan`（先规划 DAG 再确定性执行、独立步骤并行）。
- **会话隔离**——每个「窗口」的历史 + 状态完全独立。
- **账本驱动的分层上下文压缩**——上下文超阈值时，对话**类别从账本的原语结构涌现**（排错 / 执行 / 头脑风暴 / 通用），据此按类别策略处置每条消息（归档 / 删噪音 / 合并摘要），保头保尾，不是无脑截断。
- **原语层 + 相对估值**——账本条目先映射成一套通用**关系角色**（claim/choice/cause/step/…），每条带一个随上下文调制的**相对估值**；类别是这些原语价值组合出的形状，不是关键词猜的。
- **跨会话记忆 + 动态分层**——分层存储（identity / preferences / facts / ongoing）+ 按需检索注入；会话闭合时账本按估值门**增量沉淀**为记忆；记忆按召回热度在 frozen/warm/dormant 间**动态升降级**。
- **负反馈环**——压缩、召回、沉淀共享同一根信号：被反复召回的原语 kind 抬升其 bias（boost-only），反过来让同类原语更易保留 / 沉淀 / 主导类别涌现。快环（内存即时）+ 慢环（跨会话持久先验）双尺度。
- **分类涌现观测**——`/emergence` 扫全库账本，看正在自发形成的分类结构。
- **审批门**——高影响工具（fs 写 / delete / bash）走交互式审批，fail-closed。
- **MCP 客户端**——连接外部 MCP 服务器，把它们的工具桥接进来。
- **多智能体工作流**——确定性编排脚本，fan-out / pipeline 并行子智能体。
- **后台任务**——长任务后台跑，完成后主动唤醒 agent 处理结果。
- **流式健壮性**——SSE 流式解析、空闲超时（持续输出不误杀）、**大参数被 max_tokens 截断时自动续写拼接**（写大文件透明成功）、**Esc 随时打断**。
- **Ink TUI**——真彩色渐变 logo、抗抖动的 Static/streaming 分区渲染、token 用量色条、工具运行动画。

规模：约 **13,000 行 src + 7,900 行测试**，**520 个 `node:test` 用例**（519 通过 / 1 平台跳过），全部离线、可复现（用 MockLLM，不打真接口）。


---

## 上手

```bash
cd LinAgent
npm install
cp .env.example .env    # 至少填 LLM_PROVIDER + LLM_API_KEY
```

`.env.example` 列了 9 个 provider preset（`openai` / `anthropic` / `deepseek` /
`moonshot` / `dashscope` / `zhipu` / `openrouter` / `groq` / `ollama`），选一个填 key 即可。

### 运行

```bash
npm start                      # 启动 REPL（默认 loop 模式）
npm start -- --plan            # 开局进 plan 模式
npm start -- --provider deepseek --model deepseek-chat   # 覆盖 provider/模型
npm start -- --help            # 全部旗标

npm test                       # 离线测试（MockLLM，不打真接口）
npm run typecheck              # 类型检查
```

旗标优先级：**旗标 > 环境变量 > preset 默认**。可用旗标：
`--provider --model --api-key --base-url --timeout --plan --no-stream
--max-turns --context-max --home --user`。

### 打包成独立可执行（免装 Node）

基于 Node 20 SEA，把 Node runtime + 打包代码塞进一个可执行文件：

```bash
npm run build          # → dist/linagent.exe（Windows；其它平台无扩展名）
```

不跨平台（要 Linux/mac 版就在对应平台 build）、体积 ~70MB（内含整个 Node runtime，正常）。

### REPL 命令

会话：`/new [标题]` `/list` `/switch <id>` `/rm <id>` `/reset` `/plan`

上下文 / 记忆 / 账本：
- `/tokens` — token 用量色条（按类别着色）
- `/compress` — 手动触发一次压缩（账本驱动、类别化）
- `/history` — 查看当前会话消息序列（压缩后保头/摘要/保尾一目了然）
- `/ledger` — 查看当前会话账本
- `/consolidate` — 把账本沉淀进跨会话记忆
- `/emergence` — 扫全库账本看涌现的分类结构
- `/memory [list|forget <id>|clear]` — 查看/编辑记忆
- `/trace` — 打印执行 trace

工具 / 技能 / 工作流 / MCP：
- `/tools [<名字>]` — 列出所有已注册工具（名字 + 描述 + 参数 + 审批标记）；带名字看单个工具的完整 schema
- `/skill [list|show <name>]` `/workflow <任务>` `/mcp`

其它：`/help` `/exit`；处理中按 **Esc 打断**。

---

## 存储位置

三级 fallback：`LINAGENT_HOME` 环境变量 → 当前目录的 `.linagent/`（项目本地覆盖）→ 系统缓存目录
（Win `%LOCALAPPDATA%\LinAgent`、mac `~/Library/Caches/LinAgent`、Linux `~/.cache/LinAgent`）。

```
<home>/
├── sessions/              ← 会话历史 + 状态
├── ledgers/               ← 各会话账本（<sessionId>.json）
├── archives/              ← 压缩归档段（<sid>-segN.json，recall_archive 可拉回）
├── feedback/<userId>.json ← 负反馈环的跨会话 bias 先验（慢环）
└── memory/<userId>.json   ← 用户跨会话记忆
```

---

## 系统设计

### 一、Agent 循环（[src/agent.ts](src/agent.ts)）

一个 agent，两种决策模式，共享同一套记忆 / 账本 / 技能 / 后台任务：

- **loop（默认）**——经典 ReAct：每轮让 LLM 决定「直接回答 or 调工具」，走原生 tool-calling
  协议，工具结果作为 `role:"tool"` 消息回传，循环到 final answer 或 maxTurns 熔断。
- **plan**（`--plan` / `/plan`）——先让 planner 出一份 DAG（[src/plan/](src/plan/)），
  verifier 静态校验（无环、schema、expect DSL），executor 确定性执行、独立步骤并行，
  失败由 reflector 产出 patch 修补。相比 loop，独立工具能并行、LLM 调用次数更少。

### 二、LLM 客户端（[src/llm/client.ts](src/llm/client.ts)）

一份代码适配 OpenAI 兼容协议（OpenAI/DeepSeek/Moonshot/…）和 Anthropic 两套原生工具协议。
健壮性都在流式这条路上：

- **SSE 流式解析** + 工具调用分片按 index 累积拼接。
- **空闲超时**——每收到一个 chunk 就重置计时器；只有真卡死才中断，长回复不会被「总时长超时」误杀。
- **大参数自动续写**——写大文件时 arguments 常被 `max_tokens` 截断成残缺 JSON。客户端检测到截断
  （`finish_reason=length`）后**自己发起续写请求**、把残片拼回、解析成功——对上层完全透明，
  用户只看到一次成功的工具调用。救不回来才退回「请重发」提示。
- **打断**——`AbortSignal` 从 Esc 键一路贯通到 fetch，随时断流；已流式产出的部分保留，不当错误。

### 三、账本 + 原语 + 压缩 + 记忆 + 反馈（[src/ledger/](src/ledger/)、[src/memory.ts](src/memory.ts)）

这是本项目最核心的设计——把「上下文压缩」「跨会话记忆」「类别涌现」统一到**会话账本**这一份结构化状态上，再用一根**负反馈信号**把它们串成闭环：

- **账本**——每轮 LLM 可提交 patch 更新一份结构化账本（findings / decisions / open_threads /
  blockers / custom…）。账本当前内容每轮作为 `messages` 末尾的一条 system 消息注入，不进 history、
  不碰缓存前缀。
- **原语层**（[primitive.ts](src/ledger/primitive.ts)）——账本条目先映射成一套**通用关系角色**
  （`claim` 结论 / `choice` 决策 / `cause` 因果 / `step` 动作 / `block` 卡点 / `artifact` 产物 /
  `thread` 线头 / `option` 备选）。每条原语带一个 `valueOf` **相对估值** ∈ [0,1]——由 base 倾向
  + status（未解 +、已解 −）+ 被引用（承重节点 +）+ 新旧 + 反馈 bias 调制得出。**不是绝对判决，
  是随上下文变化的相对价值。**
- **类别从结构涌现**（[class-policy.ts](src/ledger/class-policy.ts)）——`emergentClass` 看账本装了
  哪些高价值原语、聚合出主导轴（cause/claim→debug、step/artifact→execution、choice/option→brainstorm），
  **份额过半才定性**，否则退回关键词先验（冷启动兜底）。类别是原语价值组合出的**形状**，不是关键词猜的。
- **分层压缩**（[compressor.ts](src/ledger/compressor.ts)）——上下文超阈值时，用涌现出的类别选处置策略：
  保头 + 保尾逐字留，中段按类别对每条消息判「归档 / 删噪音 / 合并摘要」（排错重因果链、执行重产物）。
  不变量：工具报错任何类别下都归档（证据不丢）。被压原文进 `archives/`（`recall_archive` 可拉回）。
- **沉淀为记忆**（[consolidator.ts](src/ledger/consolidator.ts)）——会话闭合时把账本字段按名路由进记忆层
  （findings→facts、open_threads→ongoing…）。核心洞察：**LLM 填账本那一刻已经在分类了**，沉淀纯代码
  路由即可，不需二次抽取 LLM 调用。默认**增量沉淀**：每轮末把稳定（存活≥2 轮）且过估值门的高价值
  原语沉进记忆，收尾再用低阈值兜底扫一遍（覆盖 ⊇ 一次性 wrap，不丢东西）。
- **记忆动态分层**（[memory.ts](src/memory.ts)）——fact 分 frozen（永注入）/ warm（按 query 召回）/
  dormant（默认不可达）三层，按累计召回热度**动态升降级**（召回够多 warm→frozen，久不碰 frozen→warm）。
  tier 只在会话首轮冻结 system 时重算，会话内 recall_count 照涨但 tier 不动——否则每轮破前缀缓存。
- **记忆注入**——identity / preferences 进冻结的 system 前缀（保缓存）；facts / ongoing 不自动注入，
  agent 判断需要时主动调 `recall_memory(query)`。
- **负反馈环**（[feedback.ts](src/ledger/feedback.ts)）——压缩 / 召回 / 沉淀共享同一根信号。recall 命中某
  原语 kind → 控制器抬升该 kind 的 bias（boost-only：召回抬升、缺席衰减到 0、**不驱负**）→ 该 bias 喂回
  `valueOf`，让同类原语更易过估值门、更易主导类别涌现、召回时更靠前。快环（内存即时影响本会话）+
  慢环（`<home>/feedback/<userId>.json` 跨会话持久先验，冷启动读回）。
- **冲突处理**——写入走 Jaccard 相似度：重复只刷时间戳；矛盾给旧 fact 打 `superseded_by`（不删，留审计链）；
  加性并存。
- **涌现观测**——[emergence.ts](src/ledger/emergence.ts) 扫全库账本，`/emergence` 看正在自发形成的分类结构。

### 四、其它子系统

- **工具**（[src/tools/](src/tools/)）——fs 读写/删、bash、calculator、weather、search、todo、
  memory、recall、skill、workflow、tasks，统一走 [registry](src/tools/registry.ts) 的 schema 校验。
- **MCP**（[src/mcp/](src/mcp/)）——连接外部 MCP 服务器，把远端工具桥接成本地工具。
- **工作流**（[src/workflow/](src/workflow/)）——确定性编排脚本，fan-out / pipeline 并行子智能体。
- **后台任务**（[src/tasks/](src/tasks/)）——长任务后台跑，完成后主动唤醒 agent（无需用户再发言）。
- **TUI**（[src/ui/](src/ui/)）——Ink 实现，Static 提交历史 + 单条 streaming 分区渲染抗抖动。

---

## 测试

```bash
npm test          # 520 个用例，全部离线、可复现
```

工具、客户端（流式/截断续写/超时/打断）、原语估值、类别结构涌现、压缩、记忆分层、负反馈环、
账本、plan、MCP、workflow 都有回归覆盖。测试:源码 ≈ 0.6:1。
