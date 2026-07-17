import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

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
  return (
    <Box borderStyle="round" borderColor={tagColor} paddingX={1}>
      <Text backgroundColor={tagColor} color="white">{` ${planMode ? 'plan:' : ''}${sessionTitle} `}</Text>
      <Text color="cyan">{' › '}</Text>
      <Text>{buf}</Text>
      <Text color="cyan">▌</Text>
    </Box>
  );
}
