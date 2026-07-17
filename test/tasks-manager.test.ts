import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTaskManager } from '../src/tasks/manager.ts';
import { MemoryTaskStore } from '../src/tasks/store.ts';

// deferred：手动控制 promise 何时结算，用来模拟快/慢任务，不依赖真实时间。
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const SID = 's1';

test('spawn: 宽限期内完成 → 同步返回结果', async () => {
  const store = new MemoryTaskStore();
  const mgr = new BackgroundTaskManager(async () => 'fast-result', store);
  // graceMs 给足，runner 立即 resolve
  const r = await mgr.spawn(SID, 'bash_exec', {}, '快任务', 1000);
  assert.equal(r.status, 'done');
  assert.equal((r as any).result, 'fast-result');
});

test('spawn: 超过宽限期 → 转后台返回 task_id，完成后可 check', async () => {
  const store = new MemoryTaskStore();
  const d = deferred<string>();
  const mgr = new BackgroundTaskManager(async () => d.promise, store);
  // graceMs=0 → 立即转后台
  const r = await mgr.spawn(SID, 'run_workflow', {}, '慢任务', 0);
  assert.equal(r.status, 'running');
  const id = (r as any).task_id as string;
  assert.ok(id);
  // 此时仍在跑
  assert.equal(mgr.check(id)!.status, 'running');
  // 结算
  d.resolve('slow-result');
  await new Promise((res) => setTimeout(res, 5));
  const t = mgr.check(id)!;
  assert.equal(t.status, 'done');
  assert.equal(t.result, 'slow-result');
});

test('spawn: 后台任务失败 → status=failed + error', async () => {
  const store = new MemoryTaskStore();
  const d = deferred<string>();
  const mgr = new BackgroundTaskManager(async () => d.promise, store);
  const r = await mgr.spawn(SID, 'bash_exec', {}, 'x', 0);
  const id = (r as any).task_id as string;
  d.reject(new Error('boom'));
  await new Promise((res) => setTimeout(res, 5));
  const t = mgr.check(id)!;
  assert.equal(t.status, 'failed');
  assert.match(t.error!, /boom/);
});

test('drainCompleted: 宽限期内同步完成的任务不再 drain（已随 spawn 返回、避免双投递）', async () => {
  const store = new MemoryTaskStore();
  const mgr = new BackgroundTaskManager(async () => 'r', store);
  const r = await mgr.spawn(SID, 'bash_exec', {}, 'x', 1000);   // 宽限期内同步完成
  assert.equal(r.status, 'done');                              // 结果已同步返回给调用方
  assert.equal(mgr.drainCompleted(SID).length, 0, '同步返回的结果不该再被 drain（否则双投递）');
});

test('drainCompleted: 转后台完成的任务投递一次，第二次为空', async () => {
  const store = new MemoryTaskStore();
  const d = deferred<string>();
  const mgr = new BackgroundTaskManager(async () => d.promise, store);
  await mgr.spawn(SID, 'run_workflow', {}, 'x', 0);            // 立即转后台
  d.resolve('slow');
  await new Promise((res) => setTimeout(res, 5));
  const first = mgr.drainCompleted(SID);
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'done');
  assert.equal(mgr.drainCompleted(SID).length, 0, '第二次应为空（已投递）');
});

test('drainCompleted: 按 sessionId 隔离（后台完成）', async () => {
  const store = new MemoryTaskStore();
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const mgr = new BackgroundTaskManager(
    async (_t, _a, sid) => (sid === 's1' ? d1.promise : d2.promise), store);
  await mgr.spawn('s1', 'bash_exec', {}, 'a', 0);
  await mgr.spawn('s2', 'bash_exec', {}, 'b', 0);
  d1.resolve('x'); d2.resolve('y');
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(mgr.drainCompleted('s1').length, 1);
  assert.equal(mgr.drainCompleted('s2').length, 1);
});

test('onComplete: 任务结算时触发回调（done + failed），canceled 不触发', async () => {
  const store = new MemoryTaskStore();
  const fired: Array<{ id: string; status: string }> = [];

  // 三个独立 manager 各测一种结局，避免 runner 分派复杂度。
  const m1 = new BackgroundTaskManager(async () => 'ok', store);
  m1.setOnComplete((t) => fired.push({ id: t.id, status: t.status }));
  await m1.spawn(SID, 'bash_exec', {}, 'done', 0);
  await new Promise((res) => setTimeout(res, 5));

  const df = deferred<string>();
  const m2 = new BackgroundTaskManager(async () => df.promise, store);
  m2.setOnComplete((t) => fired.push({ id: t.id, status: t.status }));
  await m2.spawn(SID, 'bash_exec', {}, 'fail', 0);
  df.reject(new Error('boom'));
  await new Promise((res) => setTimeout(res, 5));

  const dc = deferred<string>();
  const m3 = new BackgroundTaskManager(async () => dc.promise, store);
  m3.setOnComplete((t) => fired.push({ id: t.id, status: t.status }));
  const rc = await m3.spawn(SID, 'run_workflow', {}, 'cancel', 0);
  m3.cancel((rc as { task_id: string }).task_id);
  dc.resolve('late');
  await new Promise((res) => setTimeout(res, 5));

  const statuses = fired.map((f) => f.status).sort();
  assert.deepEqual(statuses, ['done', 'failed'], 'done+failed 触发，canceled 不触发');
});

test('cancel: 运行中可取消，已完成不可', async () => {
  const store = new MemoryTaskStore();
  const d = deferred<string>();
  const mgr = new BackgroundTaskManager(async () => d.promise, store);
  const r = await mgr.spawn(SID, 'run_workflow', {}, 'x', 0);
  const id = (r as any).task_id as string;
  assert.equal(mgr.cancel(id).ok, true);
  assert.equal(mgr.check(id)!.status, 'canceled');
  // 取消后即使 promise 结算，也不覆盖 canceled
  d.resolve('late');
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(mgr.check(id)!.status, 'canceled');
  // 再次取消已终结任务 → 失败
  assert.equal(mgr.cancel(id).ok, false);
});

test('list: 按状态过滤 + sessionId 隔离', async () => {
  const store = new MemoryTaskStore();
  const d = deferred<string>();
  const mgr = new BackgroundTaskManager(async (t) => (t === 'run_workflow' ? d.promise : 'r'), store);
  await mgr.spawn(SID, 'bash_exec', {}, 'done-one', 1000);  // 同步完成
  await mgr.spawn(SID, 'run_workflow', {}, 'running-one', 0); // 后台运行
  assert.equal(mgr.list(SID).length, 2);
  assert.equal(mgr.list(SID, 'done').length, 1);
  assert.equal(mgr.list(SID, 'running').length, 1);
  d.resolve('x');
});

test('restoreFromStore: running 任务恢复后标记 interrupted', async () => {
  const store = new MemoryTaskStore();
  // 手动塞一个 running 任务到 store（模拟上次进程崩溃遗留）
  store.save({
    id: 't-99z', label: 'orphan', tool: 'run_workflow', args: {},
    status: 'running', sessionId: SID, startedAt: 1, delivered: false,
  });
  const mgr = new BackgroundTaskManager(async () => 'r', store, () => 12345);
  const n = mgr.restoreFromStore();
  assert.equal(n, 1);
  const t = mgr.check('t-99z')!;
  assert.equal(t.status, 'interrupted');
  assert.equal(t.endedAt, 12345);
});
