import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieveForQuery } from '../src/memory.ts';
import type { UserMemory, Fact } from '../src/memory.ts';

function mkFact(id: string, text: string, cls?: string): Fact {
  return {
    id, layer: 'facts', text, confidence: 0.8,
    created_at: 0, last_seen_at: 0,
    source: { session: 's', turn: 1, class: cls },
  };
}

function mem(facts: Fact[]): UserMemory {
  return { userId: 'u', facts, next_id: facts.length + 1 };
}

test('recall 无偏置：纯 Jaccard，顺序按文本相似度', () => {
  const m = mem([
    mkFact('1', '部署 staging 配置', 'execution'),
    mkFact('2', '部署 staging 配置', 'debug'),
  ]);
  // 两条文本相同、query 相同 → 无偏置时同分，稳定排序保留输入序
  const hits = retrieveForQuery(m, '部署 staging', 5);
  assert.equal(hits.length, 2);
});

test('recall 类别偏置：同类别来源的 fact 被提前', () => {
  const m = mem([
    mkFact('1', '部署 staging 配置 相关', 'debug'),      // 来源 debug
    mkFact('2', '部署 staging 配置 相关', 'execution'),  // 来源 execution
  ]);
  // 当前会话是 execution → 偏向 execution 来源的 fact
  const hits = retrieveForQuery(m, '部署 staging 配置', 5, {
    class: 'execution', preferLayers: ['facts'], boostKeywords: ['部署'],
  });
  assert.equal(hits[0].id, '2', 'execution 来源的应排第一');
});

test('recall 偏置只重排已相关，不引入不相关记忆', () => {
  const m = mem([
    mkFact('1', '完全无关的内容', 'execution'),  // 与 query 零重叠
    mkFact('2', '部署 staging', 'debug'),
  ]);
  // 即便 fact1 是同类别，query 不重叠也不该被召回（保精度）
  const hits = retrieveForQuery(m, '部署 staging', 5, {
    class: 'execution', preferLayers: ['facts'], boostKeywords: [],
  });
  assert.ok(hits.every((f) => f.id !== '1'), '不相关 fact 不因类别偏置被引入');
  assert.equal(hits[0].id, '2');
});
