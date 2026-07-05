import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { ToolValidationError } from '../src/tools/registry.ts';
import type { MemoryHandle } from '../src/types.ts';

function mkMemoryHandle(): MemoryHandle & { _added: string[]; _forgot: string[] } {
  const items: Array<{ id: string; layer: 'identity' | 'preferences' | 'facts' | 'ongoing'; text: string; confidence: number }> = [];
  let n = 1;
  const _added: string[] = [];
  const _forgot: string[] = [];
  return {
    _added, _forgot,
    list: () => items.map((i) => ({ ...i })),
    add: (layer, text) => {
      const item = { id: `f${n++}`, layer, text, confidence: 1 };
      items.push(item);
      _added.push(text);
      return { id: item.id, layer: item.layer, text: item.text };
    },
    forget: (id) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return { ok: false, error: `no fact ${id}` };
      const [removed] = items.splice(idx, 1);
      _forgot.push(removed.id);
      return { ok: true, forgotten: removed.id };
    },
  };
}

test('memory tool: list returns current facts', async () => {
  const reg = buildDefaultRegistry();
  const mem = mkMemoryHandle();
  mem.add('identity', '住在杭州');
  const out = await reg.invoke('memory', { action: 'list' }, {
    sessionId: 's1', sessionState: {}, logger: () => {}, memory: mem,
  }) as { items: unknown[] };
  assert.equal(out.items.length, 1);
});

test('memory tool: add requires layer and non-empty text', async () => {
  const reg = buildDefaultRegistry();
  const mem = mkMemoryHandle();
  const ctx = { sessionId: 's1', sessionState: {}, logger: () => {}, memory: mem };
  await assert.rejects(() => reg.invoke('memory', { action: 'add', text: 'x' }, ctx), /layer/);
  await assert.rejects(() => reg.invoke('memory', { action: 'add', layer: 'facts', text: '' }, ctx), /text/);
});

test('memory tool: forget removes and reports', async () => {
  const reg = buildDefaultRegistry();
  const mem = mkMemoryHandle();
  mem.add('facts', '喜欢咖啡');
  const list = mem.list();
  const id = list[0].id;
  const out = await reg.invoke('memory', { action: 'forget', id }, {
    sessionId: 's1', sessionState: {}, logger: () => {}, memory: mem,
  }) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.deepEqual(mem._forgot, [id]);
});

test('memory tool: fails cleanly when no memory handle is wired', async () => {
  const reg = buildDefaultRegistry();
  await assert.rejects(
    () => reg.invoke('memory', { action: 'list' }, {
      sessionId: 's1', sessionState: {}, logger: () => {},
    }),
    /no memory store configured/,
  );
});

test('memory tool: action must be one of the enum', async () => {
  const reg = buildDefaultRegistry();
  const mem = mkMemoryHandle();
  await assert.rejects(
    () => reg.invoke('memory', { action: 'launch' }, {
      sessionId: 's1', sessionState: {}, logger: () => {}, memory: mem,
    }),
    ToolValidationError,
  );
});
