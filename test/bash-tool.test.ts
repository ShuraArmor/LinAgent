import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashExecTool } from '../src/tools/bash.ts';
import { setSandboxRoot, getSandboxRoot } from '../src/tools/fs.ts';
import type { Tool } from '../src/types.ts';

const ctx = () => ({ sessionId: 't', sessionState: {}, logger: () => {} });

async function call(t: Tool, args: Record<string, unknown>): Promise<unknown> {
  return await Promise.resolve(t.handler(args, ctx()));
}

interface R {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: { stdout: boolean; stderr: boolean };
  cwd: string;
}

test('bash_exec: 执行简单命令，收集 stdout', async () => {
  // 用 node -e 保证跨平台
  const r = await call(bashExecTool, {
    command: `node -e "process.stdout.write('hello')"`,
    timeout_ms: 5000,
  }) as R;
  assert.equal(r.exit_code, 0);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.stderr, '');
  assert.equal(r.timed_out, false);
});

test('bash_exec: 分开收集 stderr 与 exit_code', async () => {
  const r = await call(bashExecTool, {
    command: `node -e "process.stderr.write('oops'); process.exit(3)"`,
    timeout_ms: 5000,
  }) as R;
  assert.equal(r.exit_code, 3);
  assert.equal(r.stderr, 'oops');
});

test('bash_exec: 超时会 kill 进程并标记 timed_out', async () => {
  const r = await call(bashExecTool, {
    command: `node -e "setTimeout(() => {}, 60000)"`,
    timeout_ms: 300,
  }) as R;
  assert.equal(r.timed_out, true);
  // 被信号杀掉或 exit_code 非 0 都可接受
  assert.ok(r.signal !== null || (r.exit_code !== null && r.exit_code !== 0));
});

test('bash_exec: 孙子进程占住管道 close 不触发时，超时仍强制结算（不无限卡死）', { timeout: 15_000 }, async () => {
  // 复现用户 bug：cmd /c 启动 GUI（electron）后 shell 退出，但 GUI 继承并占住
  // stdout/stderr 管道 → 'close' 永不触发。旧代码只在 close 时 resolve → 永久卡住。
  // 这里用 node 派生一个 detached、继承 stdio 的孙子进程，父进程立刻退出来模拟：
  // 孙子存活并占着管道，shell 的读端拿不到 EOF，'close' 不会来。
  const script = [
    "const {spawn}=require('child_process');",
    "const g=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit',detached:true});",
    "g.unref();",
    "process.exit(0);",
  ].join('');
  const t0 = Date.now();
  const r = await call(bashExecTool, {
    command: `node -e "${script}"`,
    timeout_ms: 800,
  }) as R;
  const elapsed = Date.now() - t0;
  // 关键断言：必须在 timeout + grace + 余量 内结算，而不是等满 30s（旧代码会卡死）
  assert.ok(elapsed < 5000, `应在超时后很快强制结算，实际耗时 ${elapsed}ms`);
  assert.equal(r.timed_out, true);
});

test('bash_exec: stdout 超上限会截断并置 truncated=true', async () => {
  const script = `let s='x'.repeat(1024);for(let i=0;i<400;i++) process.stdout.write(s);`;
  const r = await call(bashExecTool, {
    command: `node -e "${script}"`,
    timeout_ms: 10_000,
  }) as R;
  assert.equal(r.truncated.stdout, true);
  assert.ok(r.stdout.length <= 256 * 1024, `stdout 长度=${r.stdout.length}`);
});

test('bash_exec: command 为空 → 拒绝', async () => {
  await assert.rejects(
    () => call(bashExecTool, { command: '   ' }),
    /非空/,
  );
});

test('bash_exec: env 参数追加到子进程', async () => {
  const r = await call(bashExecTool, {
    command: `node -e "process.stdout.write(process.env.LINAGENT_TEST||'unset')"`,
    env: { LINAGENT_TEST: 'yes' },
    timeout_ms: 5000,
  }) as R;
  assert.equal(r.stdout, 'yes');
});

test('bash_exec: 沙盒开启时 cwd 越界被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-bash-'));
  const originalRoot = getSandboxRoot();
  setSandboxRoot(dir);
  try {
    // 试图把 cwd 指到沙盒外面
    const outside = tmpdir();
    await assert.rejects(
      () => call(bashExecTool, { command: 'node -e "0"', cwd: outside }),
      /越出沙盒/,
    );
  } finally {
    setSandboxRoot(originalRoot);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bash_exec: 沙盒关闭时可执行任意 cwd', async () => {
  setSandboxRoot(null);
  const r = await call(bashExecTool, {
    command: `node -e "process.stdout.write(process.cwd())"`,
    cwd: tmpdir(),
    timeout_ms: 5000,
  }) as R;
  assert.equal(r.exit_code, 0);
  assert.ok(r.stdout.length > 0);
});
