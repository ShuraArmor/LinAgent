# AI Prompt 与问题解决记录

这份文档记录我用 AI 编程工具做 LinAgent 的过程 —— 关键的 prompt、遇到的 bug、AI 犯的错，以及我做的判断。

## 题目

原题：**Vibe coding 从零实现一个最小可用 Agent**。

硬性要求：不用 agent 框架完成主流程；实现基本 4 步循环；至少 3 个工具 + 注册机制 + schema 校验；session 管理（用户 A 两个窗口不干扰）；context 管理（最大轮次、追问、压缩）；异常处理 + trace；测试用例。

软性目标从 JD 里读出来：他们看过 langchain / dify / n8n / openhands / openclaw 都不满意，问的是"从零设计一个 agent 框架你会如何设计"。所以只做作业最低分肯定不够。

## 工具

Claude Code（Opus 4.7），一个会话贯穿全程。

## 开场 prompt

我把题目原文完整贴了一遍（其实贴了两遍，粘的时候没注意），加了一句技术选型：

> 你现在在我的 E:\ProjBuild\SelfLearn\LinAgent 下实现，基于 node 实现，tsx。严格按照要求实现

技术栈定死是有意的，不让 AI 自己去选（可能选 Python）。"严格按照要求"是不让它脑补题目没要求的东西。

Claude 上来做了几个决策我看着都合理：
- 用 `node:test` 而不是 jest（零生产依赖，符合"从零"精神）
- 走自定义 JSON 决策协议，不走 provider 原生 `tools` 字段（跨 provider 通用）
- 4 个工具（calculator + search + weather + todo）

没有反对，让它开始做。

## V1 阶段

V1 一次基本做对：4 步循环、4 工具、session 隔离、context 压缩、40 多条测试。这部分 AI 表现很稳，我基本只是 review。

如果停在这，就是标准的"AI 当代码生成器"—— 交作业，没深度。

## 关键分岔

我问了一句：

> 你觉得你设计的这个智能体是平庸的还是有什么可取创新之处，如何设计更好呢

想看 AI 会不会承认自己做的是 baseline。Claude 主动承认了：

> 说实话——**我做的这个 agent 是平庸的**。它把作业题的每一条要求都完成了，但没有一处触到"到底什么才是好的 agent 框架"这个问题。

然后给了 6 条改进方向：policy/executor 分离、结构化 context、capability 抽象、状态机化控制流、prompt 工程化、actor 化多 agent。

**我挑了 policy/executor 分离**。理由：
1. 有量化数据可以对比（LLM 调用次数）—— 面试可讲
2. 主流框架都没做这个拆分 —— 有区分度
3. 改动量能一天内落地

这是 AI 替不了我的决策。剩下 5 条继续做只会稀释重点，止损。

## AI 犯过的错

### 1. Set 无法 JSON 序列化

审批门功能的"本会话已放行工具"缓存，AI 用了 `Set<string>` 存 `session.state.__approvedTools`。Review 时看着完美 —— 直到重启进程后 session 从磁盘恢复：

```
错误: approved.has is not a function
```

`Set` 走 `JSON.stringify` 变成 `{}`，加载回来 as-断言当 Set 用就崩。

Claude 立刻抓到根因，改成 `string[]` + `includes/push`，并且加了运行时形状检查（`Array.isArray(raw) ? raw : []`）—— 就算磁盘里还有旧的 `{}` 坏数据也不炸。

我要求它加一条回归测试锁住"JSON roundtrip 后审批仍然工作"。这类存储序列化的坑一定会再犯。

### 2. Token 显示 user 是 0

`/tokens` 打印 `user 0%`，一句"你好"怎么可能是 0？

Claude 先写探针脚本复现，发现 user 有 6 tokens、实际占比 0.4%，`toFixed(0)` 把它四舍五入到 0。这是显示 bug，改了 —— 加了个 `fmtPct` 函数，<1% 显示 `<1%` 而不是 0%。

我接着追问：那 system 也是 0，这就不对了。

它才发现另一个 bug：`/tokens` 命令读的是 `lastExtras`，重启进程直接打 `/tokens` 时 `lastExtras = {}`，system prompt 那 1400 token 根本没算进去。修法是当场调 `buildSystemPrompt(registry)` 重建。

我第三次追问：memory 也是 0，我明明有 memory。

它又发现：修 system 那次，memory 那半路径没兜底，还是 `undefined`。修法是当场用最后一条 user 消息当 query，走 `retrieveForQuery` + `formatForPrompt` 重建 memory 段。

三次追问才彻底修好。这是 AI 一次修不到位的典型场景 —— 它容易只解决表层症状（数字四舍五入），深层的"数据源本身缺"要用户去挖。我的经验是，AI 说"应该没问题"的时候基本要再问一遍。

### 3. Spinner 抢跑审批面板

我截图给它看：审批面板还弹着，下面已经在转圈"执行 xxx"了。

它定位很快：`push('tool_call', ...)` 在审批**之前**就推，REPL 的 liveTrace 收到 `tool_call` 事件立刻起 spinner，然后才 `await approve()` 阻塞在弹面板上。

修法是把 `push('tool_call')` 挪到审批之后。新时序：审批 → 推 trace → REPL 起 spinner → 真执行。

这种 UX bug 只能用户视角发现。AI 在写代码时看着每一步都对，但**时序问题**它感知不到。

### 4. Live trace 永远接不到

我随口问了句"你出这么多错，能不能自查一下有没有其他错误"—— 没具体指哪。

Claude 通读了 REPL 代码后发现：每次 chat 前 REPL 都往 `DEFAULT_AGENT_CONFIG.onTrace` 赋值，但 Agent 构造时是 `new Agent(llm, registry, {...DEFAULT_AGENT_CONFIG, ...})`—— 展开到新对象了，事后写单例改不到实例。所以实时 trace 显示（tool_call 行、tool_result 行）根本从来没打印过。

修法是给 `Agent.chat` 的 `hooks` 加 `onTrace` 字段，per-call handler 优先，config-level 兜底。加了 3 条回归测试。

这次 AI 表现好。当我问"能不能自查"时它没糊弄，真的读代码找到了问题。

### 5. Reflector 写中文进 expect 字段

截图给它看：`Reflector 产出的 patch 不合法：step s2a: expect syntax 错误 — unexpected trailing input at 6`。

它定位：Reflector 把 `expect` 当自然语言字段用了，写了"result 有至少一个 item"—— 但我的 expect DSL 只接受形式化表达式（`result.ok == true`、`len(...) > 0`）。

修法有三：
1. planner 和 reflector 的 prompt 都加严明的"expect 必须形式化"说明 + 正误示例对照
2. **同时它主动发现了深层原因**：LLM 之所以要绕路走 search，是因为 weather 表只有 4 个城市，一撞到"西安"就得反射 —— 补了 23 个中国城市
3. 顺手给 search 也补了几条常见城市的天气条目

它主动做了 2 和 3，我原本只让它修 1。这是好的越界，但我逐条 review 了改动。

## 我做的、AI 做不了的判断

按项目顺序：

- 不停在 v1，做 v2
- 6 条改进方向里选 policy/executor 分离（有数据可讲，可一天落地）
- 走自定义 JSON 协议而不是 provider 原生 tool_use（跨 provider 通用比 grammar-constrained decoding 重要）
- 记忆分层而不是平铺（mem0/Zep 都是平铺，我坚持要 4 层）
- fs/bash 走审批门（AI 起初没提审批）
- v1 和 v2 存储分开（避免 schema 冲突）
- 每次 bug 修完必须写回归测试
- `.linagent` 挪到系统缓存目录（起初就地放 cwd）
- README 要坦诚列短板（AI 起初写得像功能宣传）
- 每次 AI"看起来修好了"都用真实场景验证

## 关于 AI 的一些心得

**AI 快，但不深**。它能在几分钟内产生几百行代码，写测试比我快 5-10 倍。但**判断某件事值不值得做、某个修法治不治本、什么时候止损** —— 这些它替不了。它默认走的都是均值路径。

**AI 的错误越来越隐蔽**。V1 阶段它几乎不出错，因为都是有大量训练样本的模式。真正的 bug 都出现在集成点上：Set 落盘、单例改不到实例、`/tokens` 命令依赖 chat 阶段填充的状态。这些是**逻辑正确但架构上说不通**的 bug，AI 单看每个函数都对，串起来才崩。

**只信真实运行结果，不信"应该没问题"**。token 显示 bug 就是我不满足 AI 第一次"修好了"、反复三次追问才彻底解决的。

**用 AI 的方式，比 AI 本身更决定产出上限**。同样一个 Claude Opus，一句"帮我写个 agent"能出 500 行能跑的代码；持续追问"这平庸吗"、"这治本吗"、"其他地方有问题吗"就能到 5000 行 + 171 条测试 + 两个 runtime + 有主张的架构。

## 最终产出

约 5000 行 src + 2500 行测试，171 条离线测试全绿，v1 + v2 两个 REPL，10 个工具，跨会话记忆，审批门，token 统计，v1/v2 对比脚本。README 里坦诚列的短板：planner 走 JSON 而不是原生 tool_use、token 估算精度、memory 用 Jaccard 不是 embedding、memory ingest 是同步的、v2 没接跨会话记忆。这些不是 AI 没能力做，是我主动止损 —— 做完 policy/executor 分离已经能讲清一个主张，继续加会稀释重点。
