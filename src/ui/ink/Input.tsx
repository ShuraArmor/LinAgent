import React, { useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { wrapCols, displayWidth } from '../width.ts';

/** 输入框最多显示多少行（超出只显示尾部，保证动态区高度受控、不撑破 Ink 原地重绘）。 */
const MAX_INPUT_ROWS = 6;

export interface InputProps {
  planMode: boolean;
  sessionTitle: string;
  /** 提交一行（已 trim 非空）。 */
  onSubmit: (line: string) => void;
  /** 连按两次 Ctrl-C 退出；这里上报每次 Ctrl-C，由上层计数。 */
  onCtrlC: () => void;
  /** 按 Esc 打断当前正在处理的轮（空闲时上层会忽略）。 */
  onInterrupt?: () => void;
  /** 是否禁用输入（处理中时仍允许输入排队，所以默认不禁用）。 */
  disabled?: boolean;
}

/**
 * 输入行。自己维护缓冲 + 光标。
 * - CJK 退格：按 Unicode code point 删（[...str]），不按 UTF-16 code unit。
 * - 历史上翻：↑/↓ 翻已提交过的输入。
 */
export function Input({ planMode, sessionTitle, onSubmit, onCtrlC, onInterrupt, disabled }: InputProps) {
  const [buf, setBuf] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null); // null=在编辑新行

  useInput((ch, key) => {
    if (key.ctrl && (ch === 'c')) { onCtrlC(); return; }
    // Esc：打断当前处理轮。有输入缓冲时优先清空缓冲（不误伤打字），空缓冲才上报打断。
    if (key.escape) {
      if (buf) { setBuf(''); setHistIdx(null); }
      else onInterrupt?.();
      return;
    }
    if (key.return) {
      const line = buf.trim();
      setBuf('');
      setHistIdx(null);
      if (line) {
        setHist((h) => [...h, line]);
        onSubmit(line);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setBuf((s) => [...s].slice(0, -1).join(''));  // 按 code point 删，CJK 安全
      return;
    }
    if (key.upArrow) {
      setHist((h) => {
        if (h.length === 0) return h;
        const ni = histIdx == null ? h.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(ni);
        setBuf(h[ni]);
        return h;
      });
      return;
    }
    if (key.downArrow) {
      setHist((h) => {
        if (histIdx == null) return h;
        const ni = histIdx + 1;
        if (ni >= h.length) { setHistIdx(null); setBuf(''); }
        else { setHistIdx(ni); setBuf(h[ni]); }
        return h;
      });
      return;
    }
    // 普通可见字符（含 CJK）。排除控制键。
    if (ch && !key.ctrl && !key.meta && !key.escape) {
      setBuf((s) => s + ch);
    }
  }, { isActive: !disabled });

  const tagColor = planMode ? 'magenta' : 'blue';
  const label = ` ${planMode ? 'plan:' : ''}${sessionTitle} `;

  // 高度受控视口：把输入内容按终端宽度换行，只显示尾部 MAX_INPUT_ROWS 行（光标所在的最后
  // 一行永远可见）。防止长文本把输入框无限撑高 → 动态区超过终端行数 → Ink 放弃原地重绘、
  // 状态栏被一行行复印进 scrollback（就是"满屏 loop·turn 6"那个 bug）。
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // 正文可用列宽 = 终端宽 − 边框(2) − padding(2) − 标签宽 − " › " − 光标位。留点余量。
  const budget = Math.max(20, cols - 4 - displayWidth(label) - 4);
  const wrapped = buf ? wrapCols(buf, budget) : [''];
  const overflow = wrapped.length > MAX_INPUT_ROWS;
  const shown = overflow ? wrapped.slice(wrapped.length - MAX_INPUT_ROWS) : wrapped;

  return (
    <Box borderStyle="round" borderColor={tagColor} paddingX={1} flexDirection="column">
      <Box>
        <Text backgroundColor={tagColor} color="white">{label}</Text>
        <Text color="cyan">{' › '}</Text>
        {overflow && <Text dimColor>{`⋯(+${wrapped.length - MAX_INPUT_ROWS}行) `}</Text>}
        <Text>{shown[0]}</Text>
        {shown.length === 1 && <Text color="cyan">▌</Text>}
      </Box>
      {shown.slice(1).map((line, i) => (
        <Text key={i}>
          {line}
          {i === shown.length - 2 ? <Text color="cyan">▌</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
