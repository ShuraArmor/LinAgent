/**
 * 决定 session / memory 落盘到哪个目录。
 *
 * 查找顺序（第一个命中就用）：
 *   1. 环境变量 LINAGENT_HOME=<path>
 *   2. 当前工作目录下已有 .linagent/  ← 允许"这个项目单独存"
 *   3. 操作系统的用户缓存目录 <cacheDir>/LinAgent/
 *        Windows: %LOCALAPPDATA%\LinAgent
 *        macOS:   ~/Library/Caches/LinAgent
 *        Linux:   $XDG_CACHE_HOME/LinAgent  或  ~/.cache/LinAgent
 *
 * 这样一台机器上多个项目默认共用同一份记忆；某个项目想要独立记账，只需
 * 手动在项目根 `mkdir .linagent` 即可。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

/** 操作系统默认的用户缓存目录（不含 LinAgent 子目录）。 */
function osUserCacheDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches');
  }
  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
}

let cachedRoot: string | null = null;
let cachedSource: 'env' | 'cwd' | 'os' | null = null;

/**
 * 返回 LinAgent 根目录（会确保目录存在）。
 * @param cwd 从哪个目录开始判断"项目本地 .linagent 是否存在"，默认 process.cwd()
 */
export function linagentHome(cwd: string = process.cwd()): { path: string; source: 'env' | 'cwd' | 'os' } {
  if (cachedRoot) return { path: cachedRoot, source: cachedSource! };

  // 1) 环境变量优先
  const envHome = process.env.LINAGENT_HOME;
  if (envHome && envHome.trim()) {
    const p = resolve(envHome);
    mkdirSync(p, { recursive: true });
    cachedRoot = p; cachedSource = 'env';
    return { path: p, source: 'env' };
  }

  // 2) 落到 OS 用户缓存目录（Windows: %LOCALAPPDATA%\LinAgent）。
  //    不再读项目本地 .linagent/ —— 配置/会话统一放用户目录，不污染项目目录。
  const p = join(osUserCacheDir(), 'LinAgent');
  mkdirSync(p, { recursive: true });
  cachedRoot = p; cachedSource = 'os';
  return { path: p, source: 'os' };
}

/** 仅供测试使用：清掉 memo 缓存，让下次调用重新决定。 */
export function resetLinagentHomeCache(): void {
  cachedRoot = null;
  cachedSource = null;
}

export function sessionsDir(): string {
  const dir = join(linagentHome().path, 'sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function memoryDir(): string {
  const dir = join(linagentHome().path, 'memory');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function skillsDir(): string {
  const dir = join(linagentHome().path, 'skills');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ledgersDir(): string {
  const dir = join(linagentHome().path, 'ledgers');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 反馈快照目录（Phase 2 慢环持久）：<home>/feedback/<userId>.json。 */
export function feedbackDir(): string {
  const dir = join(linagentHome().path, 'feedback');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tasksDir(): string {
  const dir = join(linagentHome().path, 'tasks');
  mkdirSync(dir, { recursive: true });
  return dir;
}
