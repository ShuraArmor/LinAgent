---
name: linagent-tuning-constants
description: LinAgent 记忆/压缩子系统的手调阈值常量与其含义（改动前先懂 tradeoff）
metadata:
  type: project
---

LinAgent 记忆与压缩里几个**手调初值**常量，都是拍脑袋的起点、靠实测磨，不是推导出来的。改动前要懂它们的 tradeoff：

**记忆沉淀（consolidator.ts）**
- `INCREMENTAL_MIN_VALUE=0.60` — 增量沉淀的估值门（hi）。只沉稳定的高价值原语。
- `BACKSTOP_MIN_VALUE=0.35` — 会话收尾兜底扫的估值门（lo），噪音地板以上全收，保证不丢 M0 会保的。
- `MIN_STABLE_AGE=2` — 原语存活≥2 轮才算"稳定"可增量沉淀，防半成品锁死。
- 平价保证：增量(hi)+兜底(lo) 的覆盖 ⊇ 同阈值一次性 wrap。见 test/memory-m1.test.ts。

**动态分层（memory.ts DEFAULT_TIERING）**
- `promoteAtRecalls=3` — warm→frozen 升级门槛（累计召回次数）。
- `demoteAfterMs=30天` — frozen→warm 冷降级（user_asserted 豁免）。
- `dormantAfterMs=90天` + `dormantMaxConf=0.75` — warm→dormant。
- `frozenCap=24` — frozen 层容量上限，超了按 frozenScore 逐回 warm。
- **关键约束**：tier 只在 freezeSystemPrompt 时重算（一会话一次），会话内 recall_count 照常涨但 tier 不动 —— 否则每轮破 provider 前缀缓存。见 [[linagent-cache-safety]]。

**压缩触发（trigger.ts）**
- `thresholdPercent=0.85`（DEFAULT_TRIGGER）—— 注意 trigger.ts:28 附近注释写的 "0.60" 是过期的，以代码为准。

**类别结构涌现（class-policy.ts deriveClassFromStructure）**
- `MIN_MASS=1.0` — 主导轴总质量地板（约"多于一条显著原语"）。挡住"单条高 base 原语一锤定音"和空/稀薄账本。
- `MIN_SHARE=0.5` — 主导轴须占总质量多数。挡住三轴纠缠时的过度自信。
- **为何用份额不用差值比**：各 kind base 悬殊（choice=0.85 vs step=0.45），旧的 `topVal≥second×1.25`
  会让混合会话动辄塌成 weak（主线失效）、单条高 base 又过度自信。份额判据两头都治。见 test/compaction-phase1.test.ts「份额」组。

**反馈控制器（feedback.ts DEFAULT_CONTROLLER）**
- `setpoint=0.25 / gain=0.30 / alpha=0.25 / clamp=0.30`。
- **boost-only（缺席中性）**：error>0 升 bias 钳到 [0,clamp]；error≤0 向 0 衰减、**下界 0 不驱负**。
  原因：recall 是稀疏一热信号，若按误差驱负会把几乎所有 kind 压到 −clamp、系统性压低估值+扭曲形状涌现。
  bias 值域是 **[0, clamp]** 不是 [−clamp, clamp]。见 test/feedback-phase2.test.ts「boost-only」组。

Phase 2 负反馈环接上后，valueOf 的 bias 会动态调这些的等效效果；在那之前它们是纯静态先验。
