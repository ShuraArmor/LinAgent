import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linagentHome, resetLinagentHomeCache } from '../src/storage.ts';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('storage: LINAGENT_HOME 优先级最高', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-h-'));
  try {
    resetLinagentHomeCache();
    withEnv({ LINAGENT_HOME: dir }, () => {
      const home = linagentHome('/some/random/cwd');
      assert.equal(home.source, 'env');
      assert.equal(home.path, dir);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); resetLinagentHomeCache(); }
});

test('storage: 项目本地 .linagent/ 存在时优先本地', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'linagent-cwd-'));
  const local = join(cwd, '.linagent');
  mkdirSync(local);
  try {
    resetLinagentHomeCache();
    withEnv({ LINAGENT_HOME: undefined }, () => {
      const home = linagentHome(cwd);
      assert.equal(home.source, 'cwd');
      assert.equal(home.path, local);
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); resetLinagentHomeCache(); }
});

test('storage: 都没有时落到 OS 用户缓存目录', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'linagent-empty-'));
  try {
    resetLinagentHomeCache();
    withEnv({ LINAGENT_HOME: undefined }, () => {
      const home = linagentHome(cwd);
      assert.equal(home.source, 'os');
      // 至少要能确保目录存在
      assert.ok(existsSync(home.path));
      // 应包含 LinAgent 子目录
      assert.match(home.path, /LinAgent$/);
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); resetLinagentHomeCache(); }
});
