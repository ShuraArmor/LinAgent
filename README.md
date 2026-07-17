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
- **账本驱动的分层上下文压缩**——上下文超阈值时按类别（system/memory/user/assistant/tool/summary）压缩，不是无脑截断。
- **跨会话记忆**——分层存储（identity / preferences / facts / ongoing / lesson）+ 按需检索注入；会话闭合时账本自动沉淀为记忆。
- **分类涌现**——扫全库账本，观察自发涌现的分类结构。
- **审批门**——高影响工具（fs 写 / delete / bash）走交互式审批，fail-closed。
- **MCP 客户端**——连接外部 MCP 服务器，把它们的工具桥接进来。
- **多智能体工作流**——确定性编排脚本，fan-out / pipeline 并行子智能体。
- **后台任务**——长任务后台跑，完成后主动唤醒 agent 处理结果。
- **流式健壮性**——SSE 流式解析、空闲超时（持续输出不误杀）、**大参数被 max_tokens 截断时自动续写拼接**（写大文件透明成功）、**Esc 随时打断**。
- **Ink TUI**——真彩色渐变 logo、抗抖动的 Static/streaming 分区渲染、token 用量色条、工具运行动画。

规模：约 **13,300 行 src + 7,300 行测试**，**440 个 `node:test` 用例**，全部离线、可复现（用 MockLLM，不打真接口）。

演示视频：[哔哩哔哩](https://b23.tv/ffXyC6V)

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

技能 / 工作流 / MCP：`/skill [list|show <name>]` `/workflow <任务>` `/mcp`

其它：`/help` `/exit`；处理中按 **Esc 打断**。

---

## 存储位置

三级 fallback：`LINAGENT_HOME` 环境变量 → 当前目录的 `.linagent/`（项目本地覆盖）→ 系统缓存目录
（Win `%LOCALAPPDATA%\LinAgent`、mac `~/Library/Caches/LinAgent`、Linux `~/.cache/LinAgent`）。

```
<home>/
├── sessions/            ← 会话历史 + 状态
├── ledgers/             ← 各会话账本（<sessionId>.json）
├── archives/            ← 压缩归档段（<sid>-segN.json，recall_archive 可拉回）
└── memory/<userId>.json ← 用户跨会话记忆
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

### 三、账本 + 压缩 + 记忆（[src/ledger/](src/ledger/)、[src/memory.ts](src/memory.ts)）

这是本项目最核心的设计——把「上下文压缩」和「跨会话记忆」统一到**会话账本**上：

- **账本**——每轮 LLM 可提交 patch 更新一份结构化账本（findings / decisions / open_threads /
  blockers / custom…）。账本当前内容每轮作为 `messages` 末尾的一条 system 消息注入，不进 history、
  不碰缓存前缀。
- **分层压缩**——上下文超阈值时，按类别策略（[class-policy.ts](src/ledger/class-policy.ts)）分别处理
  system/memory/user/assistant/tool/summary，保头 + 摘要中段 + 保尾，被压掉的原文归档到 `archives/`
  （`recall_archive` 可拉回）。
- **沉淀为记忆**——会话闭合时，[consolidator](src/ledger/consolidator.ts) 把账本字段按名路由进记忆层
  （findings→facts、open_threads→ongoing…）。核心洞察：**LLM 填账本那一刻已经在分类了**，
  沉淀纯代码路由即可，不需要二次抽取 LLM 调用。
- **记忆注入**——identity / preferences 进冻结的 system 前缀（保缓存）；facts / ongoing 不自动注入，
  agent 判断需要时主动调 `recall_memory(query)`。
- **冲突处理**——写入走 Jaccard 相似度：重复只刷时间戳；矛盾给旧 fact 打 `superseded_by`（不删，留审计链）；
  加性并存。
- **涌现**——[emergence.ts](src/ledger/emergence.ts) 扫全库账本，看正在自发形成的分类结构。

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
npm test          # 440 个用例，全部离线、可复现
```

工具、客户端（流式/截断续写/超时/打断）、压缩、记忆、账本、plan、MCP、workflow 都有回归覆盖。
测试:源码 ≈ 0.55:1。
