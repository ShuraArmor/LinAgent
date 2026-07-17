/**
 * Archive —— 被压缩掉的原始消息的归档区。
 *
 * 设计动机：压缩不是删除，是"从发给模型的视图里挪出去"。原始消息落到磁盘上一个
 * 独立文件，账本里保留 `@segN` 句柄；agent 需要细节时用 recall_archive 工具拉回。
 *
 * 一段归档 = 一次压缩对应的一批被折叠掉的消息。文件名 <sid>-seg<N>.json。
 *
 * 为什么独立存而不塞进 session：
 *   - session.json 已经很大了，全量重写代价高
 *   - 归档段一旦写就再也不改，跟活着的 session 生命周期不一样
 *   - 未来涌现分析可能想按段做统计（例如：这个用户压缩得最狠的是哪类段）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '../types.ts';

/** 归档段的物理形态。 */
export interface ArchiveSegment {
  session_id: string;
  seg_id: string;           // "seg1" / "seg2" / ... 全局递增（在同一 session 内）
  created_at: number;
  /** 被归档的原始消息，顺序保持。 */
  messages: Message[];
  /** 归档时账本处于哪一轮（用于回放时定位）。 */
  turn_at_archive: number;
}

/** 句柄格式：@seg3。压缩流程返回它，写进账本 item 的 archived_ref。 */
export function makeHandle(segId: string): string {
  return `@${segId}`;
}

/** 反解句柄：@seg3 → "seg3"。不匹配返回 null。 */
export function parseHandle(handle: string): string | null {
  const m = /^@(seg\d+)$/.exec(handle.trim());
  return m ? m[1] : null;
}

export interface ArchiveStore {
  location: string;
  /** 归档一段消息，返回分配的 seg_id 和句柄。 */
  archive(sessionId: string, messages: Message[], turn: number): { segId: string; handle: string };
  /** 按 sessionId + segId 加载一段归档；不存在返回 null。 */
  load(sessionId: string, segId: string): ArchiveSegment | null;
  /** 列出某 session 的所有归档段（按 seg_id 顺序）。 */
  listForSession(sessionId: string): ArchiveSegment[];
  /** 删除某 session 所有归档段（用于 session 被删时清理）。 */
  removeForSession(sessionId: string): number;
}

/** 内存版，只用于测试。 */
export class MemoryArchiveStore implements ArchiveStore {
  readonly location = '<memory>';
  private data = new Map<string, ArchiveSegment>();  // key = "sid/segId"

  private nextSegId(sessionId: string): string {
    let n = 0;
    for (const key of this.data.keys()) {
      if (!key.startsWith(`${sessionId}/`)) continue;
      const m = /seg(\d+)$/.exec(key);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return `seg${n + 1}`;
  }

  archive(sessionId: string, messages: Message[], turn: number): { segId: string; handle: string } {
    const segId = this.nextSegId(sessionId);
    const segment: ArchiveSegment = {
      session_id: sessionId,
      seg_id: segId,
      created_at: Date.now(),
      messages: messages.map(cloneMessage),
      turn_at_archive: turn,
    };
    this.data.set(`${sessionId}/${segId}`, segment);
    return { segId, handle: makeHandle(segId) };
  }

  load(sessionId: string, segId: string): ArchiveSegment | null {
    return this.data.get(`${sessionId}/${segId}`) ?? null;
  }

  listForSession(sessionId: string): ArchiveSegment[] {
    const out: ArchiveSegment[] = [];
    for (const [key, seg] of this.data) {
      if (key.startsWith(`${sessionId}/`)) out.push(seg);
    }
    return out.sort((a, b) => segNum(a.seg_id) - segNum(b.seg_id));
  }

  removeForSession(sessionId: string): number {
    let removed = 0;
    for (const key of Array.from(this.data.keys())) {
      if (key.startsWith(`${sessionId}/`)) { this.data.delete(key); removed++; }
    }
    return removed;
  }
}

/** 落盘版。文件名 <sid>-<segId>.json。 */
export class FileArchiveStore implements ArchiveStore {
  constructor(readonly location: string) {
    mkdirSync(location, { recursive: true });
  }

  private fileFor(sessionId: string, segId: string): string {
    return join(this.location, `${sanitize(sessionId)}-${segId}.json`);
  }

  private nextSegId(sessionId: string): string {
    if (!existsSync(this.location)) return 'seg1';
    let n = 0;
    const prefix = `${sanitize(sessionId)}-seg`;
    for (const name of readdirSync(this.location)) {
      if (!name.endsWith('.json')) continue;
      if (!name.startsWith(prefix)) continue;
      const m = /seg(\d+)\.json$/.exec(name);
      if (m) n = Math.max(n, Number(m[1]));
    }
    return `seg${n + 1}`;
  }

  archive(sessionId: string, messages: Message[], turn: number): { segId: string; handle: string } {
    const segId = this.nextSegId(sessionId);
    const segment: ArchiveSegment = {
      session_id: sessionId,
      seg_id: segId,
      created_at: Date.now(),
      messages: messages.map(cloneMessage),
      turn_at_archive: turn,
    };
    writeFileSync(this.fileFor(sessionId, segId), JSON.stringify(segment, null, 2), 'utf8');
    return { segId, handle: makeHandle(segId) };
  }

  load(sessionId: string, segId: string): ArchiveSegment | null {
    const path = this.fileFor(sessionId, segId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as ArchiveSegment;
      if (!Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  listForSession(sessionId: string): ArchiveSegment[] {
    if (!existsSync(this.location)) return [];
    const prefix = `${sanitize(sessionId)}-seg`;
    const out: ArchiveSegment[] = [];
    for (const name of readdirSync(this.location)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(this.location, name), 'utf8');
        const parsed = JSON.parse(raw) as ArchiveSegment;
        if (Array.isArray(parsed.messages)) out.push(parsed);
      } catch {
        // 静默跳过坏文件
      }
    }
    return out.sort((a, b) => segNum(a.seg_id) - segNum(b.seg_id));
  }

  removeForSession(sessionId: string): number {
    if (!existsSync(this.location)) return 0;
    const prefix = `${sanitize(sessionId)}-seg`;
    let removed = 0;
    for (const name of readdirSync(this.location)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      try { unlinkSync(join(this.location, name)); removed++; } catch { /* 忽略 */ }
    }
    return removed;
  }
}

function cloneMessage(m: Message): Message {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolName ? { toolName: m.toolName } : {}),
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
  };
}

function segNum(segId: string): number {
  const m = /seg(\d+)/.exec(segId);
  return m ? Number(m[1]) : 0;
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
}
