import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnTaskTool, checkTaskTool, listTasksTool, cancelTaskTool } from '../src/tools/tasks.ts';
import type { TaskHandle, ToolContext } from '../src/types.ts';

// 一个假的 TaskHandle，记录调用。
function fakeHandle(overrides: Partial<TaskHandle> = {}): TaskHandle {
  return {
    spawn: async () => ({ status: 'running', task_id: 't-1a' }),
    check: () => undefined,
    list: () => [],
    cancel: () => ({ ok: true }),
    ...overrides,
  };
}

function ctx(tasks?: TaskHandle): ToolContext {
  return { sessionId: 's1', sessionState: {}, logger: () => {}, tasks };
}

test('spawn_task: 未启用任务能力 → 明确报错', async () => {
  const r: any = await spawnTaskTool.handler({ tool: 'bash_exec', args: {}, label: 'x' }, ctx(undefined));
  assert.equal(r.ok, false);
  assert.match(r.error, /未启用/);
});

test('spawn_task: 拒绝非白名单工具', async () => {
  const r: any = await spawnTaskTool.handler({ tool: 'calculator', args: {}, label: 'x' }, ctx(fakeHandle()));
  assert.equal(r.ok, false);
  assert.match(r.error, /白名单/);
});

test('spawn_task: 拒绝递归 spawn_task', async () => {
  const r: any = await spawnTaskTool.handler({ tool: 'spawn_task', args: {}, label: 'x' }, ctx(fakeHandle()));
  assert.equal(r.ok, false);
  assert.match(r.error, /递归/);
});

test('spawn_task: 转后台返回 task_id', async () => {
  const r: any = await spawnTaskTool.handler(
    { tool: 'bash_exec', args: { command: 'x' }, label: '跑' },
    ctx(fakeHandle()),
  );
  assert.equal(r.ok, true);
  assert.equal(r.status, 'running');
  assert.equal(r.task_id, 't-1a');
});

test('spawn_task: 快任务同步完成回结果', async () => {
  const h = fakeHandle({ spawn: async () => ({ status: 'done', result: { stdout: 'hi' } }) });
  const r: any = await spawnTaskTool.handler({ tool: 'bash_exec', args: {}, label: 'x' }, ctx(h));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.result, { stdout: 'hi' });
});

test('check_task: 未知 id → 报错', () => {
  const r: any = checkTaskTool.handler({ task_id: 't-x' }, ctx(fakeHandle()));
  assert.equal(r.ok, false);
  assert.match(r.error, /未找到/);
});

test('check_task: 已完成任务返回结果', () => {
  const h = fakeHandle({
    check: () => ({
      id: 't-1a', label: 'x', tool: 'bash_exec', args: {}, status: 'done',
      sessionId: 's1', startedAt: 1, delivered: false, result: { ok: true },
    }),
  });
  const r: any = checkTaskTool.handler({ task_id: 't-1a' }, ctx(h));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.result, { ok: true });
});

test('list_tasks: 返回快照', () => {
  const h = fakeHandle({
    list: () => [
      { id: 't-1a', label: 'a', tool: 'bash_exec', args: {}, status: 'running', sessionId: 's1', startedAt: 1, delivered: false },
    ],
  });
  const r: any = listTasksTool.handler({}, ctx(h));
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.tasks[0].id, 't-1a');
});

test('cancel_task: 转发到 handle', () => {
  let called = '';
  const h = fakeHandle({ cancel: (id) => { called = id; return { ok: true }; } });
  const r: any = cancelTaskTool.handler({ task_id: 't-9z' }, ctx(h));
  assert.equal(r.ok, true);
  assert.equal(called, 't-9z');
});
