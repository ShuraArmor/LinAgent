/**
 * 后台任务落盘。存到 <home>/tasks/<id>.json，一个任务一个文件。
 *
 * 只存可序列化的快照（BgTask，不含运行时 promise）。进程退出后 promise 就没了，
 * 所以 loadAll 时把仍是 running 的任务标为 interrupted —— 它们的结果永远拿不回来了。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BgTask } from '../types.ts';

export interface TaskStore {
  location: string;
  save(task: BgTask): void;
  loadAll(): BgTask[];
  remove(id: string): void;
}

/** 内存版，仅供测试。 */
export class MemoryTaskStore implements TaskStore {
  readonly location = '<memory>';
  private data = new Map<string, BgTask>();
  save(t: BgTask): void { this.data.set(t.id, { ...t }); }
  loadAll(): BgTask[] { return Array.from(this.data.values()).map((t) => ({ ...t })); }
  remove(id: string): void { this.data.delete(id); }
}

/** 落盘版。 */
export class FileTaskStore implements TaskStore {
  constructor(readonly location: string) {
    mkdirSync(location, { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.location, `${sanitize(id)}.json`);
  }

  save(task: BgTask): void {
    writeFileSync(this.pathFor(task.id), JSON.stringify(task, null, 2), 'utf8');
  }

  loadAll(): BgTask[] {
    if (!existsSync(this.location)) return [];
    const out: BgTask[] = [];
    for (const name of readdirSync(this.location)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(this.location, name), 'utf8');
        const t = JSON.parse(raw) as BgTask;
        if (t && typeof t.id === 'string' && typeof t.status === 'string') out.push(t);
      } catch {
        // 静默跳过坏文件
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  remove(id: string): void {
    const p = this.pathFor(id);
    if (existsSync(p)) unlinkSync(p);
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_') || 'task';
}
