import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiStatusPanel, type PanelStream } from '../src/ui/panel.ts';

/** 收集输出的 mock stream。isTTY 可切换以测两条路径。 */
function mockStream(isTTY: boolean): PanelStream & { buf: string[] } {
  const buf: string[] = [];
  return {
    buf,
    isTTY,
    columns: 100,
    write(s: string) { buf.push(s); },
  };
}

test('panel: 非 TTY 下完全静默', () => {
  const s = mockStream(false);
  const p = new MultiStatusPanel([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], s);
  p.start();
  p.set('a', 'running');
  p.set('a', 'ok', '完成了');
  p.stop();
  assert.equal(s.buf.length, 0, '非 TTY 不应产生任何输出');
});

test('panel: 未知 id 调 set 静默忽略,不崩', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'A' }], s);
  p.start();
  assert.doesNotThrow(() => p.set('ghost', 'ok'));
  p.stop(false);
});

test('panel: TTY 下 start 会绘制所有行', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'AAA' }, { id: 'b', label: 'BBB' }], s);
  p.start();
  const drawn = s.buf.join('');
  assert.match(drawn, /AAA/);
  assert.match(drawn, /BBB/);
  p.stop(false);
});

test('panel: set(running) 后该行显示运行中', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'worker' }], s);
  p.start();
  s.buf.length = 0; // 清掉初始绘制
  p.set('a', 'running');
  assert.match(s.buf.join(''), /运行中/);
  p.stop(false);
});

test('panel: set(ok) 显示对勾 + 摘要', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'worker' }], s);
  p.start();
  s.buf.length = 0;
  p.set('a', 'ok', '这是输出摘要');
  const out = s.buf.join('');
  assert.match(out, /✓/);
  assert.match(out, /这是输出摘要/);
  p.stop(false);
});

test('panel: set(failed) 显示叉', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'worker' }], s);
  p.start();
  s.buf.length = 0;
  p.set('a', 'failed', '出错了');
  assert.match(s.buf.join(''), /✗/);
  p.stop(false);
});

test('panel: stop(false) 擦除面板(含清屏序列)', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'A' }], s);
  p.start();
  s.buf.length = 0;
  p.stop(false);
  // 擦除应含光标上移 + 清屏到底
  assert.match(s.buf.join(''), /\x1b\[\d+A\x1b\[0J/);
});

test('panel: pause 擦除面板, resume 重新绘制', () => {
  const s = mockStream(true);
  const p = new MultiStatusPanel([{ id: 'a', label: 'ROW' }], s);
  p.start();
  s.buf.length = 0;
  p.pause();
  assert.match(s.buf.join(''), /\x1b\[\d+A\x1b\[0J/, 'pause 应擦除面板');
  s.buf.length = 0;
  p.resume();
  assert.match(s.buf.join(''), /ROW/, 'resume 应重新绘制');
  p.stop(false);
});

test('panel: 非 TTY 下 pause/resume 也不报错不输出', () => {
  const s = mockStream(false);
  const p = new MultiStatusPanel([{ id: 'a', label: 'A' }], s);
  p.start();
  assert.doesNotThrow(() => { p.pause(); p.resume(); p.stop(); });
  assert.equal(s.buf.length, 0);
});
