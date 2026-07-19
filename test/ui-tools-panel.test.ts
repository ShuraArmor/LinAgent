/**
 * /tools 面板渲染：工具清单（名字 + 描述 + 审批标记 + 参数）与单个工具详情。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { Panel } from '../src/ui/ink/panels/index.tsx';
import type { PanelData } from '../src/ui/ink/panels/types.ts';

async function renderPanel(data: PanelData, cols = 100): Promise<string> {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
  out.columns = cols; out.rows = 40; out.isTTY = true;
  let buf = '';
  out.on('data', (c: Buffer) => { buf += c.toString(); });
  const { unmount } = render(
    React.createElement(Panel, { data }),
    { stdout: out as unknown as NodeJS.WriteStream, patchConsole: false },
  );
  await new Promise((r) => setTimeout(r, 60));
  unmount();
  return buf;
}

test('tools 面板: 显示工具数、名字、描述、参数', async () => {
  const buf = await renderPanel({
    type: 'tools',
    riskyCount: 1,
    rows: [
      { name: 'calculator', description: '计算算术表达式', risky: false, params: ['expression*'] },
      { name: 'fs_write', description: '写文件', risky: true, params: ['path*', 'content*', 'create_dirs'] },
    ],
  });
  assert.match(buf, /共 2 个/, '应显示工具总数');
  assert.match(buf, /1 个需审批/, '应显示需审批数量');
  assert.match(buf, /calculator/);
  assert.match(buf, /计算算术表达式/, '应显示描述');
  assert.match(buf, /expression\*/, '必填参数应带 *');
  assert.match(buf, /fs_write/);
  assert.match(buf, /⚠/, '需审批工具应有 ⚠ 标记');
});

test('tools 面板: 空列表给出提示', async () => {
  const buf = await renderPanel({ type: 'tools', rows: [], riskyCount: 0 });
  assert.match(buf, /没有已注册的工具/);
});

test('tools 面板: riskyCount=0 不显示"需审批"后缀', async () => {
  const buf = await renderPanel({
    type: 'tools', riskyCount: 0,
    rows: [{ name: 'calculator', description: '算数', risky: false, params: ['expression*'] }],
  });
  assert.match(buf, /共 1 个/);
  assert.doesNotMatch(buf, /需审批/, 'riskyCount 为 0 时不该出现审批提示');
});

test('toolShow 面板: 显示单个工具详情 + schema', async () => {
  const buf = await renderPanel({
    type: 'toolShow',
    name: 'bash_exec',
    description: '在系统 shell 里执行命令',
    risky: true,
    schema: '{\n  "type": "object",\n  "properties": {\n    "command": {...}\n  }\n}',
  });
  assert.match(buf, /bash_exec/);
  assert.match(buf, /需审批/, '高影响工具应标注需审批');
  assert.match(buf, /在系统 shell 里执行命令/);
  assert.match(buf, /参数 schema/);
  assert.match(buf, /command/, 'schema 内容应出现');
});
