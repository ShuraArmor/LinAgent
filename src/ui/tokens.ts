import { c, symbols } from './ansi.ts';
import { padEndCols, padStartCols } from './width.ts';
import {
  type CategoryBreakdown, type MsgCategory,
  humanTokens, totalTokens,
} from '../tokens.ts';

const ORDER: MsgCategory[] = ['system', 'memory_facts', 'user', 'assistant', 'tool_result', 'summary'];
const LABEL: Record<MsgCategory, string> = {
  system:       'system      ',
  memory_facts: 'memory      ',
  user:         'user        ',
  assistant:    'assistant   ',
  tool_result:  'tool_result ',
  summary:      'summary     ',
};
const COLOR: Record<MsgCategory, (s: string) => string> = {
  system:       c.gray,
  memory_facts: c.green,
  user:         c.magenta,
  assistant:    c.cyan,
  tool_result:  c.yellow,
  summary:      c.blue,
};

/** 智能显示百分比：≥10% 整数、1-10% 一位小数、<1% 显示 `<1%`（避免看到 "user 0%" 误以为没算）。 */
function fmtPct(p: number): string {
  if (p >= 10) return `${p.toFixed(0)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  if (p > 0) return `<1%`;
  return `0%`;
}

/** 一行紧凑指标：`tokens: 3.2k / 128k (2%)  [system 40% · assistant 30% · tool 20% ...]` */
export function tokenLine(b: CategoryBreakdown, ctxWindow: number): string {
  const total = totalTokens(b);
  const pct = ctxWindow > 0 ? (total / ctxWindow) * 100 : 0;
  const head =
    `${symbols.info} tokens: ${c.bold(humanTokens(total))} / ${humanTokens(ctxWindow)} ` +
    c.dim(`(${pct.toFixed(pct < 10 ? 1 : 0)}%)`);

  if (total === 0) return c.dim(head);
  const parts: string[] = [];
  for (const cat of ORDER) {
    if (b[cat] === 0) continue;
    const p = (b[cat] / total) * 100;
    parts.push(COLOR[cat](`${cat.split('_')[0]} ${fmtPct(p)}`));
  }
  return `${head}  ${c.dim('[')}${parts.join(c.dim(' · '))}${c.dim(']')}`;
}

/** 详细的柱状图（走 /tokens 命令时用）。 */
export function tokenBarChart(b: CategoryBreakdown, ctxWindow: number): string {
  const total = totalTokens(b);
  const barW = 40;
  const rows: string[] = [];
  rows.push(
    c.bold(`Token 用量`) + '  ' +
    c.dim(`共 ${humanTokens(total)} / ${humanTokens(ctxWindow)} tokens`) +
    (ctxWindow > 0 ? c.dim(`  (${((total / ctxWindow) * 100).toFixed(1)}%)`) : '')
  );
  rows.push('');
  for (const cat of ORDER) {
    const n = b[cat];
    const pctNum = total > 0 ? (n / total) * 100 : 0;
    // 至少画 1 格（如果类别 token > 0 但按比例算不到 1 格），让 user=6 tokens 也能看到条
    let filled = Math.round((pctNum / 100) * barW);
    if (n > 0 && filled === 0) filled = 1;
    const bar = COLOR[cat]('█'.repeat(filled)) + c.gray('░'.repeat(barW - filled));
    rows.push(
      `${padEndCols(LABEL[cat], 12)}  ${bar}  ` +
      padStartCols(humanTokens(n), 6) + c.dim(`  ${fmtPct(pctNum)}`)
    );
  }
  return rows.join('\n');
}
