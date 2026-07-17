import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyLedger, applyPatches, analyzeEmergence, renderEmergenceReport,
} from '../src/ledger/index.ts';
import type { Ledger } from '../src/ledger/index.ts';

/** 快速造一份带指定内容的账本。 */
function mkLedger(id: string, intent: string,
  suggestedAdds: Array<{ path: string; text: string }>,
  customAdds: Array<{ path: string; text: string }> = []): Ledger {
  const l = createEmptyLedger(id);
  applyPatches(l, [{ op: 'replace', path: 'core.intent', value: intent }], 1);
  for (const a of suggestedAdds) applyPatches(l, [{ op: 'add', path: a.path, value: { text: a.text } }], 1);
  for (const a of customAdds) applyPatches(l, [{ op: 'add', path: a.path, value: { text: a.text } }], 1);
  return l;
}

test('analyzeEmergence: 空账本集 → 空报告', () => {
  const r = analyzeEmergence([]);
  assert.equal(r.totalLedgers, 0);
  assert.equal(r.namespaceFreq.length, 0);
  assert.equal(r.presetCandidates.length, 0);
});

test('analyzeEmergence: 单次出现的 namespace 不算涌现（要 ≥ 2 份账本）', () => {
  const l = mkLedger('s1', '测试', [], [{ path: 'custom.oneoff.thing', text: 'x' }]);
  const r = analyzeEmergence([l]);
  assert.equal(r.namespaceFreq.length, 0);
});

test('analyzeEmergence: 高频 namespace 被识别、按 session 数排序', () => {
  // debug 出现在 5 份账本；refactor 3 份；oneoff 1 份（应被过滤）
  const ledgers: Ledger[] = [];
  for (let i = 0; i < 5; i++) {
    ledgers.push(mkLedger(`d${i}`, '排查', [], [
      { path: 'custom.debug.causal_chain', text: `因果 ${i}` },
    ]));
  }
  for (let i = 0; i < 3; i++) {
    ledgers.push(mkLedger(`r${i}`, '重构', [], [
      { path: 'custom.refactor.strategy', text: `策略 ${i}` },
    ]));
  }
  ledgers.push(mkLedger('one', 'oneoff', [], [
    { path: 'custom.oneoff.thing', text: 'x' },
  ]));

  const r = analyzeEmergence(ledgers);
  assert.equal(r.totalLedgers, 9);
  assert.equal(r.namespaceFreq.length, 2);
  assert.equal(r.namespaceFreq[0].namespace, 'debug');
  assert.equal(r.namespaceFreq[0].sessionCount, 5);
  assert.equal(r.namespaceFreq[1].namespace, 'refactor');
  assert.equal(r.namespaceFreq[1].sessionCount, 3);
});

test('analyzeEmergence: preset 候选提议 —— sessionCount ≥ 3 才提议', () => {
  const ledgers: Ledger[] = [];
  // debug 出现在 5 份账本（应提议）
  for (let i = 0; i < 5; i++) {
    ledgers.push(mkLedger(`d${i}`, '排查报错', [], [
      { path: 'custom.debug.causal_chain', text: `x${i}` },
    ]));
  }
  // refactor 只出现在 2 份账本（不足 candidateMin=3，不提议）
  for (let i = 0; i < 2; i++) {
    ledgers.push(mkLedger(`r${i}`, '重构', [], [
      { path: 'custom.refactor.strategy', text: `y${i}` },
    ]));
  }
  const r = analyzeEmergence(ledgers);
  assert.equal(r.presetCandidates.length, 1);
  assert.equal(r.presetCandidates[0].suggestedName, 'debug');
  assert.equal(r.presetCandidates[0].sessionCount, 5);
});

test('analyzeEmergence: preset 候选的建议关键词来自相关账本的 intent', () => {
  const ledgers: Ledger[] = [];
  for (let i = 0; i < 4; i++) {
    ledgers.push(mkLedger(`d${i}`, '排查 npm test 报错', [], [
      { path: 'custom.debug.causal_chain', text: `x${i}` },
    ]));
  }
  const r = analyzeEmergence(ledgers);
  assert.equal(r.presetCandidates.length, 1);
  const kws = r.presetCandidates[0].suggestedKeywords;
  // 应包含从 intent 抽出的高频词（"排"/"查"/"报"/"错"/"npm"/"test"）
  assert.ok(kws.length > 0);
  assert.ok(kws.includes('npm') || kws.includes('test') || kws.includes('排'));
});

test('analyzeEmergence: 字段共现 —— progress+artifacts 常一起出现', () => {
  const ledgers: Ledger[] = [];
  for (let i = 0; i < 4; i++) {
    ledgers.push(mkLedger(`e${i}`, '执行', [
      { path: 'suggested.progress', text: `p${i}` },
      { path: 'suggested.artifacts', text: `a${i}` },
    ]));
  }
  const r = analyzeEmergence(ledgers);
  const pair = r.cooccurrence.find((c) =>
    (c.pair[0] === 'progress' && c.pair[1] === 'artifacts')
    || (c.pair[0] === 'artifacts' && c.pair[1] === 'progress'),
  );
  assert.ok(pair, `没找到 progress+artifacts 共现: ${JSON.stringify(r.cooccurrence)}`);
  assert.equal(pair!.count, 4);
});

test('analyzeEmergence: intent 词频次 ≥ 2 才留下', () => {
  const ledgers: Ledger[] = [];
  ledgers.push(mkLedger('s1', 'deploy the service', []));
  ledgers.push(mkLedger('s2', 'deploy again please', []));
  ledgers.push(mkLedger('s3', 'unique-word-only', []));
  const r = analyzeEmergence(ledgers);
  const terms = r.intentTerms.map((t) => t.term);
  assert.ok(terms.includes('deploy'), 'deploy 应出现（在 2 份账本中）');
  assert.ok(!terms.includes('unique-word-only'), '独一无二的词不该出现');
});

test('renderEmergenceReport: 空报告有可读提示', () => {
  const r = analyzeEmergence([]);
  const text = renderEmergenceReport(r);
  assert.match(text, /扫描了 0 份/);
});

test('renderEmergenceReport: 有候选时展示 preset 候选段', () => {
  const ledgers: Ledger[] = [];
  for (let i = 0; i < 5; i++) {
    ledgers.push(mkLedger(`d${i}`, '排查报错', [], [
      { path: 'custom.debug.causal_chain', text: `x${i}` },
    ]));
  }
  const r = analyzeEmergence(ledgers);
  const text = renderEmergenceReport(r);
  assert.match(text, /preset 候选提议/);
  assert.match(text, /debug/);
});

test('analyzeEmergence: 一个 namespace 下多个 field 都被记录', () => {
  const ledgers: Ledger[] = [];
  for (let i = 0; i < 3; i++) {
    ledgers.push(mkLedger(`d${i}`, '排查', [], [
      { path: 'custom.debug.causal_chain', text: `c${i}` },
      { path: 'custom.debug.symptom', text: `s${i}` },
    ]));
  }
  const r = analyzeEmergence(ledgers);
  assert.equal(r.namespaceFreq.length, 1);
  const nf = r.namespaceFreq[0];
  assert.equal(nf.namespace, 'debug');
  assert.equal(nf.itemCount, 6);
  assert.ok(nf.fields.includes('causal_chain'));
  assert.ok(nf.fields.includes('symptom'));
});
