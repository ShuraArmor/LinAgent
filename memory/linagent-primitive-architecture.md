---
name: linagent-primitive-architecture
description: LinAgent 原语驱动压缩+记忆重构的整体架构与各阶段落点（Phase 0–3 全落地）
metadata:
  type: project
---

LinAgent 的压缩与记忆是**同一套原语架构**的两个时间尺度（账本=热层，记忆=温层）。设计见 docs/design-primitive-compression.md，调参见 [[linagent-tuning-constants]]。

**三根正交轴**：kind（语义角色，从账本原语带来）/ layer（语义桶，定去重）/ tier（显著性，定注入行为）。

**代码落点**：
- 类别涌现：`src/ledger/class-policy.ts` — emergentClass(结构为主+关键词兜底) / deriveClassFromStructure / classFromShape。压缩(compressor.ts)和召回(runtime.ts)都调 emergentClass。
- 原语层：`src/ledger/primitive.ts` — kindOf(path→kind) + valueOf(相对估值，含 ctx.bias)。
- 记忆：`src/memory.ts` — Fact 扩展(kind/tier/recall_count)、recomputeTiers(只在 freeze 时算，缓存安全)、bumpRecall、tokenize(词干+别名表)。
- 沉淀：`src/ledger/consolidator.ts` — consolidateStable(增量,hi门) + 兜底(lo门)，valueOf 门控。
- 结构化压缩：`src/ledger/class-policy.ts` — deriveClassFromStructure(原语价值组合涌现形状) + disposeByStructure(第一性处置)。
- 负反馈环：`src/ledger/feedback.ts` — FeedbackController(快环内存态 + 慢环 <home>/feedback/<userId>.json)。recall 命中→record→bias→喂回 valueOf。
- 装配：`src/runtime.ts` 建单例 FeedbackController，recall 工具持 record、Agent 持 bias（同一内存态引用）。

**类别涌现（主线，用户确认 Option A）**：`emergentClass(ledger, bias, presets)` 是唯一类别来源，压缩和召回**共用**——结构涌现为主（deriveClassFromStructure 看账本装了什么高价值原语），账本稀薄(weak)时退回关键词 resolveClass 当冷启动先验。类别是**真实可命名标签**，驱动 PROFILES 处置表 + recallBiasFor 召回偏置。恒开、无 flag：weak 退回关键词=等价旧行为，安全降级内建。

**曾经的弯路（别重犯）**：早期草案写"类型是副产品、溶解成连续调和"（Option B）——用户否了。"消息↔原语"硬链接在数据模型不存在（Message 无 id、evidence[] 空指、turn 关联有噪声），连续方案只能靠 featureOf 代理，不比"结构涌现类别驱动已 tuned 表"可靠，反更复杂。已删 disposeByStructure/policyForShape/compactionMode。

**默认值**：记忆 consolidate='incremental'、tiering='dynamic' 均已翻新（安全-by-construction）。

**测试**：ledger-primitive / memory-m0..m3 / compaction-phase1 / feedback-phase2 / feedback-integration，共 69 例。全量 515 绿 /1 skip。

**已知环境坑**：Windows + 并行 tsx worker 满载时全量跑偶发 worker 崩溃（掉几个测试、cancelled 1），非逻辑 bug——单跑必绿。判定失败前先重跑或单跑目标文件。
