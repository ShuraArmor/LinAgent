/**
 * BackgroundTaskManager —— session 级的后台任务管理器。
 *
 * 解决的问题：慢工具（bash 长命令、run_workflow）同步 await 会卡死整个 chat 循环 + REPL。
 * spawn() 把工具丢到后台跑：先 race 一个 graceMs 宽限期，宽限内完成就当同步任务直接返回结果
 * （快任务体验），超时才真转后台、返回 task_id，promise 继续跑、完成时落盘。
 *
 * 结果两条路回收：
 *   - agent 主动 check(id) 轮询
 *   - agent.chat 开头 drainCompleted() 把完成的任务作为通知注入下一轮
 *
 * 依赖注入：manager 不认识 registry —— 调用方给一个 runner(tool,args)=>Promise，
 * manager 只管任务生命周期。这样避免 manager ↔ tools ↔ registry 的循环依赖。
 */

import type { BgTask, TaskStatus } from '../types.ts';
import type { TaskStore } from './store.ts';

export type TaskRunner = (tool: string, args: unknown) => Promise<unknown>;

export type SpawnResult =
  | { status: 'done'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'running'; task_id: string };

/** 默认宽限期：spawn 后先同步等这么久，超时才转后台。 */
const DEFAULT_GRACE_MS = 5_000;

export class BackgroundTaskManager {
  private tasks = new Map<string, BgTask>();
  /** 运行中任务的 promise + 可选的取消器（进程类工具可挂 kill）。 */
  private running = new Map<string, { promise: Promise<unknown>; cancel?: () => void }>();
  private counter = 0;

  /**
   * @param runner 转发工具的回调（tool,args）=> Promise。由调用方（REPL）用 registry 实现。
   *   runner 拿到 sessionId 以便构造正确的 ToolContext。
   */
  /**
   * 任务完成（done/failed）时触发。REPL 挂它来"主动唤醒 agent"——任务一结算就把结果
   * 推给对话，而不是干等用户下次发言。canceled 不触发（用户主动取消，无需唤醒）。
   * 后设：用 setter 而非构造参数，因为 runtime 先 new manager、REPL 后接线。
   */
  private onComplete?: (task: BgTask) => void;

  constructor(
    private readonly runner: (tool: string, args: unknown, sessionId: string) => Promise<unknown>,
    private readonly store: TaskStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 挂/换任务完成回调（REPL 接线用）。 */
  setOnComplete(fn: (task: BgTask) => void): void {
    this.onComplete = fn;
  }

  /** 从 store 恢复：running 的标 interrupted（进程已死，promise 没了）。 */
  restoreFromStore(): number {
    let interrupted = 0;
    for (const t of this.store.loadAll()) {
      if (t.status === 'running') {
        t.status = 'interrupted';
        t.endedAt = this.now();
        this.store.save(t);
        interrupted += 1;
      }
      this.tasks.set(t.id, t);
    }
    return interrupted;
  }

  private nextId(): string {
    this.counter += 1;
    return `t-${this.counter}${idSuffix(this.counter)}`;
  }

  /**
   * 转发一个工具到后台。graceMs 内完成 → 同步返回结果；否则转后台返回 task_id。
   */
  async spawn(sessionId: string, tool: string, args: unknown, label: string, graceMs = DEFAULT_GRACE_MS): Promise<SpawnResult> {
    const id = this.nextId();
    const task: BgTask = {
      id, label, tool, args,
      status: 'running',
      sessionId,
      startedAt: this.now(),
      delivered: false,
    };
    this.tasks.set(id, task);
    this.store.save(task);

    // 起 handler promise —— 不 await，让它自己在后台结算。
    const promise = this.runner(tool, args, sessionId);
    this.running.set(id, { promise });

    // promise 结算时更新 task + 落盘（无论前台还是后台都走这里）。
    const settled = promise.then(
      (result) => this.settle(id, 'done', result, undefined),
      (err) => this.settle(id, 'failed', undefined, err instanceof Error ? err.message : String(err)),
    );

    // race 宽限期
    const graceToken = Symbol('grace');
    const raced = await Promise.race([
      settled.then(() => graceToken),
      sleep(graceMs).then(() => graceToken),
    ]).then(() => this.tasks.get(id)!);

    // 宽限期内已结算 → 结果同步返回给调用方（agent 当场就拿到），标 delivered 防止之后
    // 唤醒轮的 drainCompleted 再注入一遍（onComplete 也已触发，但 drain 会因 delivered 跳过）。
    if (raced.status === 'done' || raced.status === 'failed') {
      raced.delivered = true;
      this.store.save(raced);
      return raced.status === 'done'
        ? { status: 'done', result: raced.result }
        : { status: 'failed', error: raced.error ?? '未知错误' };
    }
    // 还在跑 → 转后台
    return { status: 'running', task_id: id };
  }

  private settle(id: string, status: 'done' | 'failed', result: unknown, error?: string): void {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return;   // 已被 cancel / 已结算 → 忽略
    t.status = status;
    t.endedAt = this.now();
    if (status === 'done') t.result = result;
    else t.error = error;
    this.store.save(t);
    this.running.delete(id);
    // 主动唤醒：任务一结算就通知 REPL（不干等用户下次发言）。回调抛错不影响任务结算。
    try { this.onComplete?.({ ...t }); } catch { /* 唤醒回调异常不阻塞任务生命周期 */ }
  }

  check(id: string): BgTask | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t } : undefined;
  }

  list(sessionId: string, status?: TaskStatus): BgTask[] {
    const all = Array.from(this.tasks.values()).filter((t) => t.sessionId === sessionId);
    const filtered = status ? all.filter((t) => t.status === status) : all;
    return filtered.map((t) => ({ ...t })).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * 取消：进程类工具能真 kill（若注册了 cancel），纯 promise 无法真停 —— 标 canceled 并忽略其结算。
   */
  cancel(id: string): { ok: boolean; error?: string } {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: `未知任务 ${id}` };
    if (t.status !== 'running') return { ok: false, error: `任务 ${id} 已是 ${t.status}，无法取消` };
    const run = this.running.get(id);
    try { run?.cancel?.(); } catch { /* 忽略 */ }
    t.status = 'canceled';
    t.endedAt = this.now();
    this.store.save(t);
    this.running.delete(id);
    return { ok: true };
  }

  /**
   * 取出所有"已完成(done/failed)且未投递"的任务，标记为已投递并返回。
   * agent.chat 开头调用它，把结果作为通知注入下一轮对话。
   */
  drainCompleted(sessionId: string): BgTask[] {
    const out: BgTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.sessionId !== sessionId) continue;
      if (!t.delivered && (t.status === 'done' || t.status === 'failed')) {
        t.delivered = true;
        this.store.save(t);
        out.push({ ...t });
      }
    }
    return out.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  }

  /** 是否有仍在后台跑的任务（REPL 空闲提示用）。 */
  hasRunning(sessionId?: string): boolean {
    return Array.from(this.tasks.values()).some(
      (t) => t.status === 'running' && (sessionId === undefined || t.sessionId === sessionId),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, Math.max(0, ms)));
}

/** 给 id 加一点随机后缀，避免同一毫秒内碰撞（不依赖 Math.random 的可测性由 counter 保证唯一）。 */
function idSuffix(n: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  return chars[n % 26];
}
