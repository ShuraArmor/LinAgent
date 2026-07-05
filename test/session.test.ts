import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry } from '../src/tools/index.ts';

test('sessions have distinct ids and titles', () => {
  const mgr = new SessionManager();
  const a = mgr.create('window-1');
  const b = mgr.create('window-2');
  assert.notEqual(a.id, b.id);
  assert.equal(a.title, 'window-1');
  assert.equal(b.title, 'window-2');
  assert.equal(mgr.list().length, 2);
  assert.equal(mgr.get(a.id), a);
});

test('todo state does not leak between sessions', async () => {
  const mgr = new SessionManager();
  const s1 = mgr.create('window-1');
  const s2 = mgr.create('window-2');
  const reg = buildDefaultRegistry();
  const mkCtx = (s: typeof s1) => ({ sessionId: s.id, sessionState: s.state, logger: () => {} });

  await reg.invoke('todo', { action: 'add', text: 'check weather' }, mkCtx(s1));
  await reg.invoke('todo', { action: 'add', text: 'write weekly report' }, mkCtx(s2));
  await reg.invoke('todo', { action: 'add', text: 'record 30-min run' }, mkCtx(s2));

  const list1 = (await reg.invoke('todo', { action: 'list' }, mkCtx(s1))) as {
    items: Array<{ text: string }>;
  };
  const list2 = (await reg.invoke('todo', { action: 'list' }, mkCtx(s2))) as {
    items: Array<{ text: string }>;
  };
  assert.equal(list1.items.length, 1);
  assert.equal(list1.items[0].text, 'check weather');
  assert.equal(list2.items.length, 2);
  assert.deepEqual(
    list2.items.map((i) => i.text),
    ['write weekly report', 'record 30-min run'],
  );
});

test('session delete', () => {
  const mgr = new SessionManager();
  const s = mgr.create();
  assert.equal(mgr.delete(s.id), true);
  assert.equal(mgr.get(s.id), undefined);
});
