/**
 * 文件系统工具。
 *
 * 沙盒是"可选"的：默认关闭 —— 也就是说 fs_read / fs_list / fs_write / fs_delete
 * 会作用于**整个文件系统**（当然还是受进程 uid 权限约束）。
 * 若调用方希望限制作用域，可以主动调 `setSandboxRoot(dir)`。此时越出该目录的
 * 路径会被拒绝。测试代码就走这条路径，把沙盒指向临时目录。
 *
 * 无论沙盒是否开启，`fs_write` / `fs_delete` 都属于高影响动作，
 * 上层 Agent 已经用 approval gate 拦一层 —— 每次都会弹审批。
 */

import { promises as fs, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import type { Tool } from '../types.ts';

const MAX_BYTES = 512 * 1024;  // 512 KB
const MAX_LIST_ENTRIES = 500;

/** 展开 realpath（Windows 上会把 8.3 短名展开为长名）。 */
function resolveRoot(dir: string): string {
  const abs = resolve(dir);
  try { return realpathSync.native(abs); } catch { return abs; }
}

/**
 * 沙盒根。`null` 表示不启用沙盒（默认）。
 * 需要限制时调 `setSandboxRoot(dir)`；调 `setSandboxRoot(null)` 可以关闭。
 */
let sandboxRoot: string | null = null;

export function setSandboxRoot(dir: string | null): void {
  sandboxRoot = dir === null ? null : resolveRoot(dir);
}

export function getSandboxRoot(): string | null {
  return sandboxRoot;
}

/**
 * 归一化路径。
 * - 沙盒关闭时：仅返回展开后的绝对路径，不做越界检查。
 * - 沙盒开启时：越出沙盒则抛错（同时防止符号链接逃逸）。
 */
async function resolvePath(input: string): Promise<{ absolute: string; rel: string }> {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('path 必须是非空字符串');
  }
  const base = sandboxRoot ?? process.cwd();
  const raw = isAbsolute(input) ? input : resolve(base, input);
  const absolute = resolve(raw);
  const realpathAsync = (fs.realpath as unknown as {
    native: (p: string) => Promise<string>;
  }).native;
  let real = absolute;
  try {
    real = await realpathAsync(absolute);
  } catch {
    // 文件不存在（可能要写入）：至少展开父目录。
    const parent = dirname(absolute);
    try {
      const parentReal = await realpathAsync(parent);
      real = resolve(parentReal, absolute.slice(parent.length + 1));
    } catch {
      // 父目录也不存在：先用 absolute
    }
  }
  if (sandboxRoot) {
    const rel = relative(sandboxRoot, real);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`路径越出沙盒: ${input}（沙盒根=${sandboxRoot}）`);
    }
    return { absolute: real, rel: rel === '' ? '.' : rel };
  }
  return { absolute: real, rel: real };
}

export const fsReadTool: Tool = {
  name: 'fs_read',
  description:
    '读取某个文本文件的内容（UTF-8）。默认可访问整个文件系统，' +
    '仅在调用方主动设置了沙盒时才受限。单文件上限 512KB，超过会拒绝。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，绝对或相对（相对路径基于沙盒根或 cwd）。' },
      max_bytes: { type: 'integer', description: '可选：本次最多读多少字节（不超过 512KB）。' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async handler(args) {
    const path = args.path as string;
    const cap = Math.min(MAX_BYTES, (args.max_bytes as number | undefined) ?? MAX_BYTES);
    const { absolute, rel } = await resolvePath(path);
    const st = await fs.stat(absolute);
    if (!st.isFile()) throw new Error(`不是文件: ${rel}`);
    if (st.size > cap) throw new Error(`文件大小 ${st.size}B 超过上限 ${cap}B`);
    const text = await fs.readFile(absolute, 'utf8');
    return { path: rel, bytes: st.size, content: text };
  },
};

export const fsListTool: Tool = {
  name: 'fs_list',
  description:
    '列出目录的直接子项（不递归）。默认可访问整个文件系统，' +
    '仅在调用方主动设置了沙盒时才受限。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，默认 "."。' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(args) {
    const input = (args.path as string | undefined) ?? '.';
    const { absolute, rel } = await resolvePath(input);
    const st = await fs.stat(absolute);
    if (!st.isDirectory()) throw new Error(`不是目录: ${rel}`);
    const names = await fs.readdir(absolute);
    const items = [];
    for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
      try {
        const childAbs = resolve(absolute, name);
        const s = statSync(childAbs);
        items.push({
          name,
          kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
          size: s.isFile() ? s.size : undefined,
        });
      } catch {
        items.push({ name, kind: 'unknown' });
      }
    }
    return {
      path: rel,
      total: names.length,
      truncated: names.length > MAX_LIST_ENTRIES,
      items,
    };
  },
};

export const fsWriteTool: Tool = {
  name: 'fs_write',
  description:
    '把文本写入某个文件（覆盖或新建）。默认可写入整个文件系统，' +
    '仅在调用方主动设置了沙盒时才受限。此动作需用户审批。写入内容上限 512KB。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，绝对或相对，例如 "notes/plan.md"。' },
      content: { type: 'string', description: '要写入的文本内容。' },
      create_dirs: { type: 'boolean', description: '父目录不存在时是否自动创建，默认 true。' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async handler(args) {
    const path = args.path as string;
    const content = args.content as string;
    const createDirs = (args.create_dirs as boolean | undefined) ?? true;
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw new Error(`写入内容 > ${MAX_BYTES}B，已拒绝`);
    }
    const { absolute, rel } = await resolvePath(path);
    if (createDirs) {
      await fs.mkdir(dirname(absolute), { recursive: true });
    }
    await fs.writeFile(absolute, content, 'utf8');
    const st = await fs.stat(absolute);
    return { path: rel, bytes: st.size, ok: true };
  },
};

export const fsDeleteTool: Tool = {
  name: 'fs_delete',
  description:
    '删除一个文件（不递归删目录）。默认可作用于整个文件系统，' +
    '仅在调用方主动设置了沙盒时才受限。此动作需用户审批。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件路径。' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async handler(args) {
    const path = args.path as string;
    const { absolute, rel } = await resolvePath(path);
    const st = await fs.stat(absolute);
    if (!st.isFile()) throw new Error(`不是文件（拒绝删除目录）: ${rel}`);
    await fs.unlink(absolute);
    return { path: rel, ok: true, bytes: st.size };
  },
};

// RISKY_TOOLS 移到 tools/index.ts —— 那里才能统一囊括所有需要审批的工具（包括 bash_exec）。

// 为了让路径解析可跨平台，本文件里出现 `sep` 只是为了让 TS 不 tree-shake 掉
// import；不参与实际逻辑。
void sep;
