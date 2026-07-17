import React from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import type { HistoryEntry, StreamingEntry } from './store.ts';
import { LOGO_ROWS, LOGO_GRADIENT_HEX, LOGO_TAGLINE } from '../logo.ts';
import { Panel } from './panels/index.tsx';
import { COLORS, toolTheme } from './theme.ts';
import { wrapCols, displayWidth } from '../width.ts';

/** 卡片最大宽度（列）—— 超宽终端上限制卡片宽度，避免一行拉满整屏难读。 */
const MAX_CARD_COLS = 100;

/**
 * 计算卡片正文的可用列宽预算。
 * 终端宽度封顶 MAX_CARD_COLS，再扣掉边框(2) + paddingX(2) + 标签宽度。
 * 关键：Ink 的 <Text> 只在有确定宽度约束时才自动换行；shrink-to-content 的框
 * （alignSelf=flex-start）宽度由内容决定，长行不会自动换 → 会把框撑到超屏。
 * 所以这里用 CJK 感知的 wrapCols 手动预换行，从根上杜绝超宽。
 */
function useContentBudget(labelReserve: number): number {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const cap = Math.min(cols, MAX_CARD_COLS);
  return Math.max(20, cap - 4 - labelReserve);
}

/** 按预算换行，同时保留文本里已有的换行符（markdown 段落/表格）。 */
function wrapText(text: string, budget: number): string[] {
  const out: string[] = [];
  for (const seg of text.split('\n')) {
    if (seg === '') { out.push(''); continue; }  // 保留空行
    for (const l of wrapCols(seg, budget)) out.push(l);
  }
  return out.length ? out : [''];
}

/**
 * 会话双方的消息卡片。标签在左、正文在右侧的列里逐行排布（换行行对齐到正文起点）。
 * 正文预先按终端宽度 wrap，框 shrink-to-content 后既紧凑又绝不超屏。
 */
function SpeakerCard({ label, labelColor, borderColor, text, textColor }: {
  label: string;
  labelColor: string;
  borderColor: string;
  text: string;
  textColor: string;
}) {
  const labelW = displayWidth(label + ' ');
  const budget = useContentBudget(labelW);
  const lines = wrapText(text, budget);
  return (
    // marginBottom：会话卡片自带下间距，作为与后续内容/输入框的分隔。放在 committed 侧（随
    // <Static> 永久、随历史滚动），而不是放在每帧重绘的动态区 —— 后者会在回车时残留空行。
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} alignSelf="flex-start" marginBottom={1}>
      <Text color={labelColor} bold>{label} </Text>
      <Box flexDirection="column">
        {lines.map((l, i) => <Text key={i} color={textColor}>{l || ' '}</Text>)}
      </Box>
    </Box>
  );
}

/** 用户消息卡片 —— 柔紫边框，一眼区分"这是我说的"。 */
function UserCard({ text }: { text: string }) {
  return (
    <SpeakerCard
      label="用户" labelColor={COLORS.userAccent}
      borderColor={COLORS.userBorder} text={text} textColor="white"
    />
  );
}

/** 智能体答复卡片 —— 青蓝边框，与用户的紫框互补，区分谁在说话。 */
function AgentCard({ text }: { text: string }) {
  return (
    <SpeakerCard
      label="◆ Agent" labelColor={COLORS.agentAccent}
      borderColor={COLORS.agentBorder} text={text} textColor="whiteBright"
    />
  );
}

/**
 * 流式进行中的 Agent 卡片 —— **一开始就有青框**，内容在框里逐字生长。
 *
 * 关键：框是高度受控的"视口"。内容按终端宽度换行后，只显示最新的尾部
 * MAX_STREAM_ROWS 行；框总高度因此恒 ≤ 终端高度 → Ink 每帧都能完整擦除重画，
 * 框头永远不会滚出屏幕顶部 → 不会出现"双头"残框。
 * 超出视口时顶部标一行「⋮ 上文已省略」，提示还有更多；收尾 endStream 时
 * 完整全文作为普通 AgentCard 提交进 <Static>，一字不丢。
 */
const MAX_STREAM_ROWS = 10;

/**
 * 计算流式视口：把文本按宽度换行后，只取尾部若干行 + 是否溢出 + 省略了几行。
 * 视口行数上限 = min(MAX_STREAM_ROWS, 终端高 - 余量)，保证动态区高度恒定受控、永不超屏
 * （这是抗抖动的关键：动态区一超屏，Ink 就退化成全屏擦重画，长文本 + 工具弹出就打架）。
 */
function useStreamViewport(text: string, labelWidth: number): { shown: string[]; hiddenLines: number } {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cap = Math.max(3, Math.min(MAX_STREAM_ROWS, rows - 8));
  const budget = useContentBudget(labelWidth);
  const allLines = wrapText(text, budget);
  if (allLines.length <= cap) return { shown: allLines, hiddenLines: 0 };
  return { shown: allLines.slice(allLines.length - cap), hiddenLines: allLines.length - cap };
}

function StreamingAgentCard({ text }: { text: string }) {
  const { shown, hiddenLines } = useStreamViewport(text, displayWidth('◆ Agent '));
  return (
    <Box borderStyle="round" borderColor={COLORS.agentBorder} paddingX={1} alignSelf="flex-start" marginBottom={1}>
      <Text color={COLORS.agentAccent} bold>◆ Agent </Text>
      <Box flexDirection="column">
        {hiddenLines > 0 && <Text dimColor>{`⋮ 上文 ${hiddenLines} 行，完成后展开`}</Text>}
        {shown.map((l, i) => (
          <Text key={i} color="whiteBright">
            {l || ' '}
            {i === shown.length - 1 ? <Text color={COLORS.agentAccent}>▌</Text> : null}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** 流式思考（thinking）—— 同样做尾部截断，避免长思考撑爆动态区触发全屏重画。 */
function StreamingThinking({ text }: { text: string }) {
  const { shown, hiddenLines } = useStreamViewport(text, displayWidth('💭 '));
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hiddenLines > 0 && <Text dimColor>{`💭 ⋮ 上文 ${hiddenLines} 行`}</Text>}
      {shown.map((l, i) => (
        <Text key={i} color={COLORS.thinking}>
          {i === 0 && hiddenLines === 0 ? '💭 ' : '   '}{l || ' '}
          {i === shown.length - 1 ? <Text color={COLORS.agentAccent}>▌</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

/** 工具调用行 —— 按工具主题上色 + 专属图标；risky 工具额外标记。 */
function ToolCallLine({ name, text }: { name: string; text: string }) {
  const t = toolTheme(name);
  return (
    <Text>
      <Text color={t.color} bold>{t.icon} {name}</Text>
      {t.risky ? <Text color="#ec7063"> ⚠</Text> : null}
      <Text dimColor>  {stripName(text, name)}</Text>
    </Text>
  );
}

/** 工具结果行 —— 用工具主题色的对勾，正文压暗。 */
function ToolResultLine({ name, text }: { name: string; text: string }) {
  const t = toolTheme(name);
  return (
    <Text>
      {'  '}<Text color={t.color}>└─ ✓</Text> <Text dimColor>{stripName(text, name)}</Text>
    </Text>
  );
}

/** 去掉结果/调用文本里冗余的工具名前缀（store 里已单独带 toolName）。 */
function stripName(text: string, name: string): string {
  if (text.startsWith(name)) return text.slice(name.length).trimStart();
  return text;
}

/** 单条历史的渲染样式，按 kind 区分。React.memo：未变化的条目不重渲染。 */
const Line = React.memo(function Line({ entry }: { entry: HistoryEntry }) {
  const { kind, text } = entry;
  switch (kind) {
    case 'panel':
      return entry.panel ? <Box marginTop={1} marginBottom={1}><Panel data={entry.panel} /></Box> : null;
    case 'logo':
      return (
        <Box flexDirection="column" marginBottom={1}>
          {LOGO_ROWS.map((row, i) => <Text key={i} color={LOGO_GRADIENT_HEX[i]}>{row}</Text>)}
          <Box marginTop={1}><Text dimColor>{LOGO_TAGLINE}</Text></Box>
        </Box>
      );
    case 'user':
      return <UserCard text={text} />;
    case 'thinking':
      return <Text color={COLORS.thinking}>{'💭 '}{text}</Text>;
    case 'assistant':
    case 'final':
      return <AgentCard text={text} />;
    case 'tool_call':
      return <ToolCallLine name={entry.toolName ?? ''} text={text} />;
    case 'tool_result':
      return <ToolResultLine name={entry.toolName ?? ''} text={text} />;
    case 'error':
      return <Text color="red">{'✗ '}{text}</Text>;
    case 'compress':
      return <Text dimColor>{'⚙ '}{text}</Text>;
    case 'system':
      return <Text dimColor>{text}</Text>;
    default:
      return <Text>{text}</Text>;
  }
});

/**
 * 历史区：committed 走 <Static>（只渲染一次、不参与逐帧重绘 → 抗抖动核心）；
 * streaming（正在逐字追加的那条）走下方动态区，每帧重绘。流式 Agent 卡片带边框，
 * 但高度受控为一个视口（StreamingAgentCard），框高恒 ≤ 终端高 → 不会滚出屏幕顶部
 * 造成"双头"残框。Static 输出天然在动态区上方，视觉上 streaming 自然接在历史后面。
 */
export function History({ committed, streaming }: {
  committed: HistoryEntry[];
  streaming: StreamingEntry | null;
}) {
  return (
    <>
      <Static items={committed}>
        {(entry) => <Box key={entry.id}><Line entry={entry} /></Box>}
      </Static>
      {streaming && (
        // 两种流式都走"尾部视口"截断：动态区高度恒定受控，永不超屏 → 不触发全屏重画、
        // 不与工具行打架。完整内容在 endStream 时提交进 <Static>，一字不丢。
        streaming.kind === 'thinking'
          ? <StreamingThinking text={streaming.text} />
          : <StreamingAgentCard text={streaming.text} />
      )}
    </>
  );
}
