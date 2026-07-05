import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, FileSessionStore } from '../src/session.ts';

function mkStore() {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-'));
  return { dir, store: new FileSessionStore(dir) };
}

test('persistence: save/load a single session across managers', () => {
  const { dir, store } = mkStore();
  try {
    const mgr1 = new SessionManager(store);
    const s = mgr1.create('window-x');
    s.history.push({ role: 'user', content: 'hi' });
    s.state.todos = { items: [{ id: 1, text: 'a', done: false, createdAt: 1 }], nextId: 2 };
    mgr1.save(s);

    // Simulate restart with the same directory.
    const mgr2 = new SessionManager(new FileSessionStore(dir));
    const loaded = mgr2.get(s.id);
    assert.ok(loaded, 'session should reload');
    assert.equal(loaded?.title, 'window-x');
    assert.equal(loaded?.history[0]?.content, 'hi');
    const todos = loaded?.state.todos as { items: Array<{ text: string }> };
    assert.equal(todos.items[0].text, 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: delete removes the file too', () => {
  const { dir, store } = mkStore();
  try {
    const mgr = new SessionManager(store);
    const s = mgr.create();
    mgr.save(s);
    mgr.delete(s.id);
    const mgr2 = new SessionManager(new FileSessionStore(dir));
    assert.equal(mgr2.get(s.id), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: malformed files are skipped, not fatal', async () => {
  const { dir, store } = mkStore();
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'trash.json'), 'not json at all');
    const mgr = new SessionManager(store);
    assert.equal(mgr.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: counter recovers from restored ids so new ids don\'t collide', () => {
  const { dir, store } = mkStore();
  try {
    const mgr1 = new SessionManager(store);
    const a = mgr1.create();
    mgr1.create();
    const mgr2 = new SessionManager(new FileSessionStore(dir));
    const c = mgr2.create();
    const nOf = (id: string) => Number(id.match(/^s(\d+)/)?.[1] ?? -1);
    assert.ok(nOf(c.id) > nOf(a.id), 'new session id should be higher after restart');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
