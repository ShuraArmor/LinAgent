import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ApprovalPrompt } from './store.ts';

interface Opt { value: 'approve' | 'approve_session' | 'deny'; label: string; desc: string; hotkey: string; }

const OPTIONS: Opt[] = [
  { value: 'approve',         label: '允许一次',     desc: '这次放行，之后同类调用还会问', hotkey: 'y' },
  { value: 'approve_session', label: '本会话都允许', desc: '当前会话内该工具直接放行',   hotkey: 'a' },
  { value: 'deny',            label: '拒绝',         desc: '把"用户拒绝"当结果回喂给 agent', hotkey: 'n' },
];

/**
 * 底部弹出的工具审批面板。↑/↓ 选，Enter 确认，y/a/n 快捷键，Esc=拒绝。
 * 只在 store.approval 非空时挂载；确认后调 prompt.resolve 把决定传回挂起的 approve()。
 */
export function Approval({ prompt }: { prompt: ApprovalPrompt }) {
  const [idx, setIdx] = useState(0);

  const choose = (v: Opt['value']) => prompt.resolve(v);

  useInput((ch, key) => {
    if (key.upArrow || ch === 'k') { setIdx((i) => (i - 1 + OPTIONS.length) % OPTIONS.length); return; }
    if (key.downArrow || ch === 'j') { setIdx((i) => (i + 1) % OPTIONS.length); return; }
    if (key.return) { choose(OPTIONS[idx].value); return; }
    if (key.escape) { choose('deny'); return; }
    const hit = OPTIONS.find((o) => o.hotkey === ch);
    if (hit) choose(hit.value);
  });

  // 参数预览：每行截断到 ~100 列（长命令/长 content 没必要全显示），最多 8 行，超出标省略。
  const MAX_COLS = 100;
  const MAX_LINES = 8;
  const rawLines = JSON.stringify(prompt.args, null, 2).split('\n');
  const clip = (l: string) => (l.length > MAX_COLS ? l.slice(0, MAX_COLS) + ' …' : l);
  const argsPreview = rawLines.slice(0, MAX_LINES).map(clip);
  const hiddenLines = rawLines.length - argsPreview.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Text color="yellow" bold>⚠  Agent 想调用高影响工具：<Text color="cyanBright">{prompt.toolName}</Text><Text dimColor>  (turn {prompt.turn})</Text></Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>参数：</Text>
        {argsPreview.map((l, i) => <Text key={i} dimColor>{'  ' + l}</Text>)}
        {hiddenLines > 0 && <Text dimColor>{`  … 还有 ${hiddenLines} 行（已省略）`}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((o, i) => (
          <Text key={o.value} color={i === idx ? 'cyanBright' : undefined} bold={i === idx}>
            {i === idx ? '❯ ' : '  '}[{o.hotkey}] {o.label}
            <Text dimColor>  {o.desc}</Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>↑/↓ 选择 · Enter 确认 · y/a/n 快捷 · Esc 拒绝</Text>
    </Box>
  );
}
