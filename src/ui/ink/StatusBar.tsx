import React from 'react';
import { Box, Text } from 'ink';
import type { StatusState } from './store.ts';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** token 用量迷你进度条。 */
function tokenBar(used: number, total: number, width = 12): string {
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const fill = Math.round(ratio * width);
  return '▓'.repeat(fill) + '░'.repeat(width - fill);
}

/** 状态信息栏：turn · provider · token · plan 标记 · live spinner。 */
export function StatusBar({ status, frame }: { status: StatusState; frame: number }) {
  const pct = status.contextWindow > 0
    ? Math.round((status.tokensUsed / status.contextWindow) * 100)
    : 0;
  return (
    <Box>
      <Text backgroundColor={status.planMode ? 'magenta' : 'blue'} color="white">
        {' '}{status.planMode ? 'plan' : 'loop'} · turn {status.turn}{' '}
      </Text>
      <Text dimColor>
        {'  '}{status.provider}
        {'  '}<Text color="blueBright">{tokenBar(status.tokensUsed, status.contextWindow)}</Text> {pct}%
      </Text>
      <Box flexGrow={1} />
      {status.busy
        ? <Text color="yellow">{SPIN[frame]} 处理中 · Esc 打断</Text>
        : <Text dimColor>就绪 · /help 看命令</Text>}
    </Box>
  );
}
