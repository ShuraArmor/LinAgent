/**
 * LedgerStore —— 账本落盘。
 *
 * 独立于 session 存到 <home>/ledgers/<sessionId>.json（B3 选择）。
 * 好处：emergence.ts 能扫全库账本做涌现分析，而不用加载 session 的完整 history。
 *
 * 一个账本一个文件，不搞索引 —— 数量在千级以内，全盘扫描很轻。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ledger } from './types.ts';
import { createEmptyLedger, normalizeLedger } from './ledger.ts';

export interface LedgerStore {
  location: string;
  /** 加载指定 session 的账本；不存在则创建空账本（不落盘，等 save 时才写）。 */
  load(sessionId: string, language?: string): Ledger;
  save(ledger: Ledger): void;
  remove(sessionId: string): void;
  loadAll(): Ledger[];
}

/** 内存版，仅供测试。 */
export class MemoryLedgerStore implements LedgerStore {
  readonly location = '<memory>';
  private data = new Map<string, Ledger>();

  load(sessionId: string, language = 'zh'): Ledger {
    const existing = this.data.get(sessionId);
    if (existing) return existing;
    const fresh = createEmptyLedger(sessionId, language);
    // 不立即缓存 —— save 时才认。这样 load 出未 save 的空账本不会污染 loadAll。
    return fresh;
  }

  save(ledger: Ledger): void {
    this.data.set(ledger.session_id, ledger);
  }

  remove(sessionId: string): void {
    this.data.delete(sessionId);
  }

  loadAll(): Ledger[] {
    return Array.from(this.data.values());
  }
}

/** 落盘版。 */
export class FileLedgerStore implements LedgerStore {
  constructor(readonly location: string) {
    mkdirSync(location, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.location, `${sanitize(sessionId)}.json`);
  }

  load(sessionId: string, language = 'zh'): Ledger {
    const path = this.pathFor(sessionId);
    if (!existsSync(path)) return createEmptyLedger(sessionId, language);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Ledger>;
      return normalizeLedger(parsed, sessionId);
    } catch {
      // 损坏文件 —— 用空账本兜底，不 throw 出去炸 REPL
      return createEmptyLedger(sessionId, language);
    }
  }

  save(ledger: Ledger): void {
    writeFileSync(this.pathFor(ledger.session_id), JSON.stringify(ledger, null, 2), 'utf8');
  }

  remove(sessionId: string): void {
    const path = this.pathFor(sessionId);
    if (existsSync(path)) unlinkSync(path);
  }

  loadAll(): Ledger[] {
    if (!existsSync(this.location)) return [];
    const out: Ledger[] = [];
    for (const name of readdirSync(this.location)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(this.location, name), 'utf8');
        const parsed = JSON.parse(raw) as Partial<Ledger>;
        const sid = typeof parsed.session_id === 'string' ? parsed.session_id : name.replace(/\.json$/, '');
        out.push(normalizeLedger(parsed, sid));
      } catch {
        // 静默跳过坏文件
      }
    }
    return out.sort((a, b) => a.created_at - b.created_at);
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
}
