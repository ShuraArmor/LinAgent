import React, { useSyncExternalStore, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { UIStore } from './store.ts';
import { History } from './History.tsx';
import { StatusBar } from './StatusBar.tsx';
import { Input } from './Input.tsx';
import { Approval } from './Approval.tsx';
import { WorkflowLive } from './WorkflowLive.tsx';
import { SPINNER, toolTheme } from './theme.ts';

/** 工具运行中的动画行 —— 按工具主题上色的 spinner + 图标 + 名称。 */
function ToolRunning({ name, frame }: { name: string; frame: number }) {
  const t = toolTheme(name);
  return (
    <Box>
      <Text color={t.color} bold>{SPINNER[frame % SPINNER.length]} {t.icon} {name}</Text>
      <Text dimColor> 运行中…</Text>
    </Box>
  );
}

export interface AppProps {
  store: UIStore;
  onSubmit: (line: string) => void;
  onCtrlC: () => void;
  /** 按 Esc 打断当前处理轮。 */
  onInterrupt?: () => void;
}

/**
 * 顶层布局。抗抖动关键：
 *   - History 里的 committed 走 <Static>（一次性、不重绘）；
 *   - 每帧真正重绘的只有：streaming 一条 + 状态栏 + 输入框/审批（高度 < 一屏）。
 * LOGO 作为 committed 的第一条（开场打印一次，随历史滚动），不做固定 Header。
 */
export function App({ store, onSubmit, onCtrlC, onInterrupt }: AppProps) {
  const committed = useSyncExternalStore(store.subscribe, store.getCommitted);
  const streaming = useSyncExternalStore(store.subscribe, store.getStreaming);
  const status = useSyncExternalStore(store.subscribe, store.getStatus);
  const approval = useSyncExternalStore(store.subscribe, store.getApproval);
  const workflow = useSyncExternalStore(store.subscribe, store.getWorkflow);
  const activeTool = useSyncExternalStore(store.subscribe, store.getActiveTool);

  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!status.busy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % 10), 120);
    return () => clearInterval(t);
  }, [status.busy]);

  return (
    <Box flexDirection="column">
      <History committed={committed} streaming={streaming} />
      {workflow && <WorkflowLive goal={workflow.goal} nodes={workflow.nodes} />}
      {activeTool && <Box marginTop={1}><ToolRunning name={activeTool} frame={frame} /></Box>}
      {/*
        抗"回车累积空行"关键：分隔 committed 与输入框的空行绝不能放在这个每帧重绘的动态区里。
        否则每次提交新 committed 卡片 <Static> 会把它写在动态区上方、把动态区顶下去，终端滚动时
        动态区顶部那行空行滚进永久 scrollback，Ink 擦不掉 → 每次回车都残留一行。
        所以间距改由 committed 卡片自带 marginBottom（随历史滚动、天然永久），这里不再加 marginTop。
      */}
      <Box flexDirection="column">
        <StatusBar status={status} frame={frame} />
        {approval
          ? <Approval prompt={approval} />
          : <Input
              planMode={status.planMode}
              sessionTitle={status.sessionTitle}
              onSubmit={onSubmit}
              onCtrlC={onCtrlC}
              onInterrupt={onInterrupt}
            />}
      </Box>
    </Box>
  );
}
