import React from 'react';
import { Box, Text } from 'ink';
import type { WorkflowNodeView } from './panels/types.ts';

const ICON: Record<WorkflowNodeView['status'], string> = { wait: '·', running: '⠿', ok: '✓', failed: '✗' };
const COLOR: Record<WorkflowNodeView['status'], string> = { wait: 'gray', running: 'yellow', ok: 'green', failed: 'red' };

/**
 * workflow 实时状态块（动态区，随子 agent 状态刷新）。
 * 只在 store.workflow 非空时挂载；完成后由 index.tsx 提交进历史（workflowResult 面板）再清空。
 */
export function WorkflowLive({ goal, nodes }: { goal: string; nodes: WorkflowNodeView[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Text color="cyan" bold>多智能体工作流执行中  <Text dimColor>{goal}</Text></Text>
      {nodes.map((n) => (
        <Text key={n.id}>
          <Text color={COLOR[n.status]}>{ICON[n.status]}</Text> <Text color="cyan">{n.id}</Text>(<Text dimColor>{n.role}</Text>)
          {n.note ? <Text dimColor>  {n.note}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
