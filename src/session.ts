import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, TraceEntry } from './types.ts';

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  /** 会话历史（不含 system prompt，那部分每轮重建）。 */
  history: Message[];
  /** 会话级可变状态，供工具使用（例如 todo 列表）。 */
  state: Record<string, unknown>;
  /** 循环的结构化 trace，仅存在内存里，供 /trace 命令和调试查看。 */
  trace: TraceEntry[];
}

export interface SessionStore {
  save(session: Session): void;
  loadAll(): Session[];
  remove(id: string): void;
  location: string;
}

/** 纯内存版 store，不落盘，仅供测试使用。 */
export class MemorySessionStore implements SessionStore {
  readonly location = '<memory>';
  save(): void {}
  loadAll(): Session[] { return []; }
  remove(): void {}
}

/** 落盘版 store：`<dir>/<sessionId>.json`，一个 session 一个文件。 */
export class FileSessionStore implements SessionStore {
  constructor(readonly location: string) {
    mkdirSync(location, { recursive: true });
  }

  save(session: Session): void {
    const path = join(this.location, `${session.id}.json`);
    writeFileSync(path, JSON.stringify(session, null, 2), 'utf8');
  }

  loadAll(): Session[] {
    if (!existsSync(this.location)) return [];
    const out: Session[] = [];
    for (const name of readdirSync(this.location)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(this.location, name), 'utf8');
        const s = JSON.parse(raw) as Session;
        if (s && typeof s.id === 'string' && Array.isArray(s.history)) {
          if (!Array.isArray(s.trace)) s.trace = [];
          if (typeof s.state !== 'object' || s.state === null) s.state = {};
          out.push(s);
        }
      } catch {
        // 静默跳过格式损坏的 session 文件
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(id: string): void {
    const path = join(this.location, `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private counter = 0;

  constructor(private readonly store: SessionStore = new MemorySessionStore()) {
    for (const s of store.loadAll()) {
      this.sessions.set(s.id, s);
      const match = s.id.match(/^s(\d+)-/);
      if (match) this.counter = Math.max(this.counter, Number(match[1]));
    }
  }

  create(title?: string): Session {
    this.counter += 1;
    const id = `s${this.counter}-${Math.random().toString(36).slice(2, 6)}`;
    const s: Session = {
      id,
      title: title ?? `window-${this.counter}`,
      createdAt: Date.now(),
      history: [],
      state: {},
      trace: [],
    };
    this.sessions.set(id, s);
    this.store.save(s);
    return s;
  }

  save(session: Session): void {
    this.store.save(session);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  require(id: string): Session {
    const s = this.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  delete(id: string): boolean {
    const ok = this.sessions.delete(id);
    if (ok) this.store.remove(id);
    return ok;
  }

  get location(): string {
    return this.store.location;
  }
}
