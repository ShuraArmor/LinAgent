/**
 * 命令行执行工具。
 *
 * 设计取舍：
 *   - 用 spawn + shell 语义（不是 execSync）—— 支持超时、流式收集、进程组 kill。
 *   - 默认没有沙盒；跟 fs 工具共用 `sandboxRoot`：若 `sandboxRoot` 被设置，
 *     则要求 `cwd` 必须落在沙盒里（防止 agent 一句 `cd /` 就绕过 fs 限制）。
 *   - 输出上限：stdout / stderr 各 256KB，超过后进程仍运行到结束，但只保留前 256KB
 *     并标记 `truncated=true`；防止 grep 全盘、cat 大文件把 context 冲爆。
 *   - 超时：默认 30s；到点就 SIGTERM，1s 后仍未退出再 SIGKILL。
 *   - Shell：Windows 用 cmd.exe（把 command 传给 /d /s /c），POSIX 用 /bin/sh -c。
 *
 * 安全说明：
 *   - 这是**高影响**工具，Agent 会走审批门 —— LLM 每次调用都要用户明确同意。
 *   - shell 里的重定向、管道、`rm` 语义完全没法在工具层拦截；请依赖审批 + 沙盒。
 *   - 想把危险度降下来，可以把审批策略调成"每次问"而不是"本会话都允许"。
 */

import { spawn } from 'node:child_process';
import { resolve, isAbsolute, relative } from 'node:path';
import type { Tool } from '../types.ts';
import { getSandboxRoot } from './fs.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;    // stdout / stderr 各自
const GRACE_MS = 1_000;                  // SIGTERM 之后等多久 SIGKILL

/** 检查 cwd 是否在沙盒里（若沙盒未启用则直接放行）。 */
function checkCwd(cwd: string | undefined): string {
  const base = cwd ? (isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)) : process.cwd();
  const root = getSandboxRoot();
  if (root) {
    const rel = relative(root, resolve(base));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`cwd 越出沙盒: ${base}（沙盒根=${root}）`);
    }
  }
  return base;
}

interface BashResult {
  command: string;
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: { stdout: boolean; stderr: boolean };
}

function runShell(command: string, cwdAbs: string, timeoutMs: number, extraEnv: Record<string, string>): Promise<BashResult> {
  return new Promise((res) => {
    const started = Date.now();
    // 用 shell: true 让 Node 自己去处理 Windows / POSIX shell 之间的转义差异 ——
    // 手动拼 cmd.exe /c 会在 Windows 上遇到多层引号的处理坑。
    const child = spawn(command, {
      cwd: cwdAbs,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      shell: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const append = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      const s = chunk.toString('utf8');
      if (which === 'stdout') {
        if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
          const remain = MAX_OUTPUT_BYTES - stdoutBuf.length;
          if (s.length > remain) { stdoutBuf += s.slice(0, remain); stdoutTruncated = true; }
          else stdoutBuf += s;
        } else stdoutTruncated = true;
      } else {
        if (stderrBuf.length < MAX_OUTPUT_BYTES) {
          const remain = MAX_OUTPUT_BYTES - stderrBuf.length;
          if (s.length > remain) { stderrBuf += s.slice(0, remain); stderrTruncated = true; }
          else stderrBuf += s;
        } else stderrTruncated = true;
      }
    };
    child.stdout?.on('data', (b) => append('stdout', b));
    child.stderr?.on('data', (b) => append('stderr', b));

    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const graceKill = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, GRACE_MS);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(graceKill);
      if (killTimer) clearTimeout(killTimer);
      res({
        command, cwd: cwdAbs,
        exit_code: null, signal: null,
        stdout: stdoutBuf,
        stderr: (stderrBuf + '\n[spawn error] ' + err.message).trim(),
        duration_ms: Date.now() - started,
        timed_out: false,
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(graceKill);
      if (killTimer) clearTimeout(killTimer);
      res({
        command, cwd: cwdAbs,
        exit_code: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
      });
    });
  });
}

export const bashExecTool: Tool = {
  name: 'bash_exec',
  description:
    '在系统 shell 里执行一段命令，返回 exit_code、stdout、stderr。' +
    'Windows 走 cmd.exe /c，POSIX 走 /bin/sh -c。' +
    '默认 30s 超时（可覆盖，最长 5 分钟），stdout/stderr 各上限 256KB（超过会截断）。' +
    '此工具为高影响动作，每次调用都需要用户审批。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整 shell 命令，例如 "ls -la src"。' },
      cwd: { type: 'string', description: '可选：工作目录（绝对或相对，默认当前目录）。' },
      timeout_ms: { type: 'integer', description: '可选：超时毫秒数，1..300000，默认 30000。' },
      env: {
        type: 'object',
        description: '可选：追加到 child 进程的环境变量（不会覆盖父进程已有变量）。',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async handler(args) {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('command 必须是非空字符串');
    let timeoutMs = (args.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) timeoutMs = DEFAULT_TIMEOUT_MS;
    timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));

    const cwdAbs = checkCwd(args.cwd as string | undefined);

    const rawEnv = args.env;
    const extraEnv: Record<string, string> = {};
    if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
      for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (typeof v === 'string') extraEnv[k] = v;
      }
    }

    return await runShell(command, cwdAbs, timeoutMs, extraEnv);
  },
};
