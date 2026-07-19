/**
 * 负反馈环（Phase 2）—— 压缩与记忆共享的同一根信号。
 *
 * 思想（见 docs/design-primitive-compression.md）：原语的估值不该是永远静态的先验。
 * 系统该观察"哪些 kind 的原语事后被反复召回"——那说明当初低估了它的价值——据此
 * **回调** valueOf 的 bias，让同类原语下次更容易被保留/沉淀。这是个控制器：
 *   误差 = 期望显著性(setpoint) − 观测显著性(EMA of 召回率)
 *   bias ← clamp( bias + gain × 误差 )
 * 保留度低但常被召回的 kind，bias 升；从不被召回的，bias 向 0 衰减。
 *
 * 两层时间尺度：
 *   快环（内存）—— 会话内 recall 即时 bump，立刻影响本会话后续压缩/沉淀。
 *   慢环（JSON）—— 跨会话持久，冷启动时作为先验读入，避免每次从零学。
 */

import type { PrimitiveKind } from './primitive.ts';

/** 一个 kind 的反馈状态。 */
export interface KindFeedback {
  /** 当前 bias ∈ [0, CLAMP]（boost-only：召回抬升，缺席衰减到 0，不驱负）。直接喂给 valueOf 的 ctx.bias。 */
  bias: number;
  /** 召回率的指数移动平均（观测显著性）。 */
  ema: number;
  /** 累计召回次数（可观测/调试用）。 */
  recalls: number;
}

/** 全量反馈快照（每个 kind 一条）。 */
export interface FeedbackState {
  version: 1;
  kinds: Partial<Record<PrimitiveKind, KindFeedback>>;
  /** 观测总次数（recall + 非 recall 机会），EMA 的分母侧参考。 */
  observations: number;
}

/** 控制器参数 —— 手调初值。 */
export interface ControllerConfig {
  /** 期望显著性设定点：EMA 收敛到此值时误差为 0、bias 不再动。 */
  setpoint: number;
  /** 比例增益：误差 → bias 增量的系数。 */
  gain: number;
  /** EMA 平滑系数 α ∈ (0,1]，越大越跟新观测。 */
  alpha: number;
  /** bias 的对称硬钳位（防跑飞、防碾压 base）。 */
  clamp: number;
}

export const DEFAULT_CONTROLLER: ControllerConfig = {
  setpoint: 0.25,
  gain: 0.30,
  alpha: 0.25,
  clamp: 0.30,   // 与 primitive.ts 注释的 bias 量级 [-0.3,0.3] 对齐
};

function clampTo(v: number, c: number): number {
  return v < -c ? -c : v > c ? c : v;
}

/** 空状态。 */
export function emptyFeedback(): FeedbackState {
  return { version: 1, kinds: {}, observations: 0 };
}

function ensureKind(s: FeedbackState, k: PrimitiveKind): KindFeedback {
  let kf = s.kinds[k];
  if (!kf) { kf = { bias: 0, ema: 0, recalls: 0 }; s.kinds[k] = kf; }
  return kf;
}

/**
 * 记一次**召回命中**：该 kind 的观测信号=1，其余 kind 本次观测信号=0。
 * 更新每个已知 kind 的 EMA，再按控制律更新 bias。就地改 state。
 *
 * 为什么其余 kind 也更新：不被召回是"负证据"，它们的 EMA 该向 0 滑，bias 才会
 * 松回。否则一个 kind 涨上去就永远下不来（积分饱和）。
 */
export function recordRecall(
  state: FeedbackState,
  hitKinds: PrimitiveKind[],
  cfg: ControllerConfig = DEFAULT_CONTROLLER,
): void {
  const hit = new Set(hitKinds);
  state.observations += 1;
  // 已知 kind ∪ 本次命中 kind 都要更新。
  const universe = new Set<PrimitiveKind>([
    ...(Object.keys(state.kinds) as PrimitiveKind[]),
    ...hitKinds,
  ]);
  for (const k of universe) {
    const kf = ensureKind(state, k);
    const signal = hit.has(k) ? 1 : 0;
    if (signal) kf.recalls += 1;
    // EMA 更新（观测显著性）。
    kf.ema = kf.ema + cfg.alpha * (signal - kf.ema);
    // 控制律（**boost-only，缺席中性**）：
    //   误差 = 观测 − 设定点。
    //   error > 0（被低估）→ bias 升（正积分），钳到 [0, clamp]。
    //   error ≤ 0（召回不足/从不召回）→ bias 向 0 **衰减**，不驱负。
    // 为什么不驱负：recall 是稀疏一热信号，绝大多数 kind 每轮都是 0，若按误差驱负会把
    // 几乎所有 kind 压到 −clamp，系统性压低账本估值、扭曲形状涌现（与设计"缺席=中性"相悖）。
    // 衰减用误差量级做速率，负得越狠松得越快，但下界是 0——"没被召回"只让加成消失，不惩罚。
    const error = kf.ema - cfg.setpoint;
    if (error > 0) {
      kf.bias = clampTo(kf.bias + cfg.gain * error, cfg.clamp);   // 只升，钳位
    } else {
      const decayed = kf.bias + cfg.gain * error;                 // error<0 → 减
      kf.bias = decayed < 0 ? 0 : decayed;                        // 地板 0，不驱负
    }
  }
}

/**
 * 导出成 valueOf 能直接用的 bias 映射。只吐非零项，省得污染 ctx。
 */
export function biasMap(state: FeedbackState): Partial<Record<PrimitiveKind, number>> {
  const out: Partial<Record<PrimitiveKind, number>> = {};
  for (const [k, kf] of Object.entries(state.kinds) as Array<[PrimitiveKind, KindFeedback]>) {
    if (kf.bias !== 0) out[k] = kf.bias;
  }
  return out;
}

// ── 存储（慢环持久 + 快环内存）─────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface FeedbackStore {
  location: string;
  load(userId: string): FeedbackState;
  save(userId: string, state: FeedbackState): void;
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'default';
}

/** 归一化：给旧/残缺快照补齐字段，坏文件退化为空态（不抛）。 */
export function normalizeFeedback(raw: unknown): FeedbackState {
  const s = emptyFeedback();
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<FeedbackState>;
    if (r.kinds && typeof r.kinds === 'object') {
      for (const [k, v] of Object.entries(r.kinds)) {
        if (v && typeof v === 'object') {
          const kf = v as Partial<KindFeedback>;
          s.kinds[k as PrimitiveKind] = {
            bias: Number.isFinite(kf.bias) ? Number(kf.bias) : 0,
            ema: Number.isFinite(kf.ema) ? Number(kf.ema) : 0,
            recalls: Number.isFinite(kf.recalls) ? Number(kf.recalls) : 0,
          };
        }
      }
    }
    if (Number.isFinite(r.observations)) s.observations = Number(r.observations);
  }
  return s;
}

/** 纯内存版（快环 / 测试）。 */
export class MemoryFeedbackStore implements FeedbackStore {
  readonly location = '<memory>';
  private data = new Map<string, FeedbackState>();
  load(userId: string): FeedbackState {
    return this.data.get(userId) ?? emptyFeedback();
  }
  save(userId: string, state: FeedbackState): void {
    this.data.set(userId, state);
  }
}

/**
 * 反馈控制器 —— 把"快环（内存态）"和"慢环（持久 store）"合成一个句柄。
 *   - 构造时从 store 读回先验（冷启动不从零学）到内存态。
 *   - record()：recall 命中即时更新内存态（快环，立刻影响本会话后续压缩/沉淀），
 *               并写回 store（慢环持久，跨会话累积）。
 *   - bias()：读内存态导出 valueOf 用的 bias 映射（每轮读，不碰磁盘）。
 * recall 工具持有 record，Agent 持有 bias —— 同一个内存态引用，天然共享。
 */
export class FeedbackController {
  private state: FeedbackState;
  constructor(
    private readonly store: FeedbackStore,
    private readonly userId: string,
    private readonly cfg: ControllerConfig = DEFAULT_CONTROLLER,
  ) {
    this.state = store.load(userId);  // 冷启动读先验
  }
  /** recall 命中：更新快环 + 持久慢环。kinds 为空则忽略。 */
  record(hitKinds: PrimitiveKind[]): void {
    if (!hitKinds.length) return;
    recordRecall(this.state, hitKinds, this.cfg);
    try { this.store.save(this.userId, this.state); } catch { /* 持久失败不阻塞召回 */ }
  }
  /** 当前 bias 映射（喂给 valueOf）。 */
  bias(): Partial<Record<PrimitiveKind, number>> {
    return biasMap(this.state);
  }
  /** 只读快照（观测/测试用）。 */
  snapshot(): FeedbackState { return this.state; }
}

/** 落盘版（慢环）：`<location>/<userId>.json`。坏文件不阻塞，退化空态。 */
export class FileFeedbackStore implements FeedbackStore {
  constructor(readonly location: string) { mkdirSync(location, { recursive: true }); }
  private pathFor(userId: string): string {
    return join(this.location, `${sanitizeId(userId)}.json`);
  }
  load(userId: string): FeedbackState {
    const p = this.pathFor(userId);
    if (!existsSync(p)) return emptyFeedback();
    try {
      return normalizeFeedback(JSON.parse(readFileSync(p, 'utf8')));
    } catch {
      return emptyFeedback();  // 冷启动读先验失败 → 空态，不崩
    }
  }
  save(userId: string, state: FeedbackState): void {
    writeFileSync(this.pathFor(userId), JSON.stringify(state, null, 2), 'utf8');
  }
}
