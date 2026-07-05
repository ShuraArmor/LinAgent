import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fsReadTool, fsListTool, fsWriteTool, fsDeleteTool,
  setSandboxRoot,
} from '../src/tools/fs.ts';
import type { Tool } from '../src/types.ts';

function mkSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-fs-'));
  setSandboxRoot(dir);
  return dir;
}
function cleanup(dir: string) { rmSync(dir, { recursive: true, force: true }); }
const ctx = () => ({ sessionId: 't', sessionState: {}, logger: () => {} });

// Tool.handler 返回 `unknown | Promise<unknown>`；测试里统一 Promise 化。
async function call(t: Tool, args: Record<string, unknown>): Promise<unknown> {
  return await Promise.resolve(t.handler(args, ctx()));
}

test('fs_read: 读取沙盒内的文件', async () => {
  const dir = mkSandbox();
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello 中文', 'utf8');
    const out = await call(fsReadTool, { path: 'a.txt' }) as {
      path: string; bytes: number; content: string;
    };
    assert.equal(out.path, 'a.txt');
    assert.match(out.content, /hello 中文/);
  } finally { cleanup(dir); }
});

test('fs_read: 拒绝沙盒外的相对路径', async () => {
  const dir = mkSandbox();
  try {
    await assert.rejects(
      () => call(fsReadTool, { path: '../../../etc/passwd' }),
      /沙盒/,
    );
  } finally { cleanup(dir); }
});

test('fs_read: 拒绝沙盒外的绝对路径', async () => {
  const dir = mkSandbox();
  try {
    const outside = join(tmpdir(), 'linagent-outside.txt');
    writeFileSync(outside, 'nope', 'utf8');
    try {
      await assert.rejects(
        () => call(fsReadTool, { path: outside }),
        /沙盒/,
      );
    } finally { rmSync(outside, { force: true }); }
  } finally { cleanup(dir); }
});

test('fs_read: 拒绝通过 symlink 逃逸', async (t) => {
  // Windows 上 tmpdir 通常也做了 symlink（Local\Temp -> AppData\Local\Temp）；
  // 加上非管理员建不了 symlink 的问题，这个断言在 win32 上不稳定，跳过。
  if (process.platform === 'win32') { t.skip('win32 skip'); return; }
  const dir = mkSandbox();
  const outside = mkdtempSync(join(tmpdir(), 'linagent-out-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'top secret', 'utf8');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'lnk'), 'file');
    } catch {
      t.skip('symlink not permitted');
      return;
    }
    await assert.rejects(
      () => call(fsReadTool, { path: 'lnk' }),
      /沙盒/,
    );
  } finally { cleanup(dir); cleanup(outside); }
});

test('fs_list: 列出直接子项', async () => {
  const dir = mkSandbox();
  try {
    writeFileSync(join(dir, 'a.txt'), '1', 'utf8');
    mkdirSync(join(dir, 'sub'));
    const out = await call(fsListTool, { path: '.' }) as {
      items: Array<{ name: string; kind: string }>;
    };
    const names = out.items.map((i) => i.name).sort();
    assert.deepEqual(names, ['a.txt', 'sub']);
    const kind = Object.fromEntries(out.items.map((i) => [i.name, i.kind]));
    assert.equal(kind['a.txt'], 'file');
    assert.equal(kind['sub'], 'dir');
  } finally { cleanup(dir); }
});

test('fs_write: 写入并读回，包含 CJK', async () => {
  const dir = mkSandbox();
  try {
    await call(fsWriteTool, { path: 'notes/plan.md', content: '# 计划\n第一条：写代码' });
    const abs = join(dir, 'notes', 'plan.md');
    assert.ok(existsSync(abs));
    assert.equal(readFileSync(abs, 'utf8'), '# 计划\n第一条：写代码');
  } finally { cleanup(dir); }
});

test('fs_write: 拒绝越出沙盒', async () => {
  const dir = mkSandbox();
  try {
    await assert.rejects(
      () => call(fsWriteTool, { path: '../evil.sh', content: 'rm -rf /' }),
      /沙盒/,
    );
  } finally { cleanup(dir); }
});

test('fs_write: 超过 512KB 会被拒', async () => {
  const dir = mkSandbox();
  try {
    const huge = 'x'.repeat(600 * 1024);
    await assert.rejects(
      () => call(fsWriteTool, { path: 'big.txt', content: huge }),
      /上限|拒绝/,
    );
  } finally { cleanup(dir); }
});

test('fs_delete: 删除文件', async () => {
  const dir = mkSandbox();
  try {
    writeFileSync(join(dir, 'gone.txt'), 'bye', 'utf8');
    await call(fsDeleteTool, { path: 'gone.txt' });
    assert.ok(!existsSync(join(dir, 'gone.txt')));
  } finally { cleanup(dir); }
});

test('fs_delete: 拒绝删目录', async () => {
  const dir = mkSandbox();
  try {
    mkdirSync(join(dir, 'sub'));
    await assert.rejects(
      () => call(fsDeleteTool, { path: 'sub' }),
      /目录/,
    );
    assert.ok(existsSync(join(dir, 'sub')));
  } finally { cleanup(dir); }
});
