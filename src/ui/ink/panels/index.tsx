/**
 * 命令面板组件集合。每个面板吃一份不可变数据快照 → 渲染，无内部状态。
 * Panel 分派组件按 data.type 选对应子组件。全部进 <Static>，快照不变、不重绘。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { PanelData, WorkflowNodeView, MemoryFactView } from './types.ts';
import { humanTokens, totalTokens } from '../../../tokens.ts';

const LAYER_LABEL: Record<string, string> = {
  identity: 'identity（身份）', preferences: 'preferences（偏好）',
  facts: 'facts（事实）', ongoing: 'ongoing（进行中）',
};

function MemoryPanel({ facts }: { facts: MemoryFactView[] }) {
  if (!facts.length) return <Text dimColor>（暂无记忆）</Text>;
  const layers = ['identity', 'preferences', 'facts', 'ongoing'] as const;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>跨会话记忆</Text>
      {layers.map((layer) => {
        const items = facts.filter((f) => f.layer === layer);
        if (!items.length) return null;
        return (
          <Box key={layer} flexDirection="column" marginTop={1}>
            <Text color="cyan">{LAYER_LABEL[layer]}</Text>
            {items.map((f) => (
              <Text key={f.id}>{'  '}<Text dimColor>{f.id}</Text>  {f.text}  <Text dimColor>({f.confidence.toFixed(2)})</Text></Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

function TokensPanel({ b, ctx }: { b: (PanelData & { type: 'tokens' })['breakdown']; ctx: number }) {
  const total = totalTokens(b);
  // 每个类别配一个语义色，色条按类别着色（不再全是同一个蓝）。
  const cats: [string, number, string][] = [
    ['system',    b.system,       'gray'],        // 基础设施：工具 schema + 角色约束
    ['memory',    b.memory_facts, 'magenta'],     // 跨会话记忆注入
    ['user',      b.user,         'green'],        // 用户输入
    ['assistant', b.assistant,    'cyan'],         // 模型输出
    ['tool',      b.tool_result,  'yellow'],       // 工具返回
    ['summary',   b.summary,      'blue'],         // 压缩摘要
  ];
  const maxv = Math.max(1, ...cats.map(([, v]) => v));
  const pct = ctx > 0 ? Math.round((total / ctx) * 100) : 0;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>Token 用量  <Text dimColor>{humanTokens(total)} / {humanTokens(ctx)} ({pct}%)</Text></Text>
      {cats.map(([name, v, color]) => {
        const w = Math.round((v / maxv) * 24);
        return (
          <Text key={name}>{'  '}<Text color={color}>{name.padEnd(10)}</Text><Text color={color}>{'█'.repeat(w)}</Text> {humanTokens(v)}</Text>
        );
      })}
    </Box>
  );
}

function SkillsPanel({ items }: { items: { name: string; description: string }[] }) {
  if (!items.length) return <Text dimColor>（暂无可用 skill）</Text>;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>Skills（{items.length}）</Text>
      {items.map((s) => <Text key={s.name}>{'  '}<Text color="cyan">{s.name}</Text>  <Text dimColor>{s.description}</Text></Text>)}
      <Text dimColor>{'  '}用 /skill show &lt;name&gt; 看完整正文</Text>
    </Box>
  );
}

function SessionsPanel({ rows, location }: { rows: (PanelData & { type: 'sessions' })['rows']; location: string }) {
  if (!rows.length) return <Text dimColor>（暂无会话）</Text>;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>会话列表</Text>
      {rows.map((s) => (
        <Text key={s.id} color={s.active ? 'cyanBright' : undefined}>
          {s.active ? '❯ ' : '  '}<Text dimColor>{s.id}</Text>  {s.title}  <Text dimColor>({s.msgs} 消息{s.todos ? `, ${s.todos} todo` : ''})</Text>
        </Text>
      ))}
      <Text dimColor>{location}</Text>
    </Box>
  );
}

/** 每种消息角色/标签的颜色，与 /tokens 色条语义保持一致。 */
function historyRowColor(role: string, isSummary: boolean): string {
  if (isSummary) return 'blue';           // 压缩摘要（与 /tokens 的 summary 蓝一致）
  if (role === 'user') return 'green';
  if (role === 'assistant') return 'cyan';
  if (role === 'tool') return 'yellow';
  return 'gray';                          // system 等
}

function HistoryPanel({ rows, total, tokens }: PanelData & { type: 'history' }) {
  if (!total) return <Text dimColor>（当前会话还没有消息）</Text>;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>会话消息序列  <Text dimColor>{total} 条 · {humanTokens(tokens)} tok</Text></Text>
      <Text dimColor>{'  '}head=保头 · summary=压缩摘要 · 其余为原始消息</Text>
      {rows.map((r) => {
        const color = historyRowColor(r.role, r.isSummary);
        return (
          <Text key={r.idx}>
            {'  '}<Text dimColor>{String(r.idx).padStart(3)}</Text>{' '}
            <Text color={color} bold={r.isSummary}>{r.tag.padEnd(16)}</Text>
            <Text dimColor>{String(r.tokens).padStart(6)}t </Text>
            <Text color={r.isSummary ? 'blueBright' : undefined}>{r.preview}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function TracePanel({ entries }: { entries: (PanelData & { type: 'trace' })['entries'] }) {
  if (!entries.length) return <Text dimColor>（本会话暂无 trace）</Text>;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>执行 Trace（{entries.length}）</Text>
      {entries.map((e, i) => (
        <Text key={i}><Text dimColor>[{e.turn}] {e.kind.padEnd(12)}</Text> {e.summary}</Text>
      ))}
    </Box>
  );
}

function McpPanel({ servers }: { servers: (PanelData & { type: 'mcp' })['servers'] }) {
  if (!servers.length) return <Text dimColor>（未连接任何 MCP 服务器）</Text>;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>MCP 服务器</Text>
      {servers.map((s) => (
        <Box key={s.name} flexDirection="column">
          <Text>{'  '}<Text color="cyan">{s.name}</Text>  <Text dimColor>{s.tools} 工具, {s.resources} 资源, {s.prompts} prompts</Text></Text>
          {s.toolNames.slice(0, 12).map((t) => <Text key={t} dimColor>{'    · '}{t}</Text>)}
        </Box>
      ))}
    </Box>
  );
}

function LedgerPanel({ d }: { d: PanelData & { type: 'ledger' } }) {
  if (!d.rendered) return <Text dimColor>（账本还是空的 — 让 agent 跑几轮就有内容了）</Text>;
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>会话账本</Text>
      <Text>{d.rendered}</Text>
      <Text dimColor>(turn={d.turn}, preset={d.preset}, updated={d.updated})</Text>
    </Box>
  );
}

function EmergencePanel({ report }: { report: (PanelData & { type: 'emergence' })['report'] }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>涌现分析  <Text dimColor>扫描 {report.totalLedgers} 份账本</Text></Text>
      {report.namespaceFreq.length === 0
        ? <Text dimColor>{'  '}尚无稳定的 custom namespace（需 ≥2 份账本共现）</Text>
        : report.namespaceFreq.slice(0, 10).map((n) => (
            <Text key={n.namespace}>{'  · '}<Text color="cyan">{n.namespace}</Text>  <Text dimColor>{n.sessionCount} 份 / {n.itemCount} 条 / {n.fields.slice(0, 4).join(', ')}</Text></Text>
          ))}
      {report.presetCandidates.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">📌 preset 候选：</Text>
          {report.presetCandidates.map((p) => (
            <Text key={p.suggestedName}>{'  · '}<Text color="cyan">{p.suggestedName}</Text>  <Text dimColor>{p.reason}</Text></Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function ConsolidatePanel({ d }: { d: PanelData & { type: 'consolidate' } }) {
  return (
    <Box flexDirection="column">
      <Text color="green">✓ 巩固完成</Text>
      <Text dimColor>{'  '}候选 {d.candidates} · 新增 {d.added} · 刷新 {d.updated} · 替代 {d.superseded}</Text>
      <Text dimColor>{'  '}记忆条目 {d.before} → {d.after}</Text>
    </Box>
  );
}

function PlanResultPanel({ d }: { d: PanelData & { type: 'planResult' } }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>▸ Plan  <Text dimColor>{d.goal}</Text></Text>
      {d.steps.map((s) => (
        <Text key={s.id}>{'  '}<Text dimColor>[{s.id}]</Text> <Text color={s.kind === 'respond' ? 'magenta' : 'yellow'}>{s.kind}</Text> {s.detail}</Text>
      ))}
      <Text dimColor>{'  '}LLM 调用={d.llmCalls} · 耗时={(d.elapsedMs / 1000).toFixed(1)}s</Text>
    </Box>
  );
}

const WF_ICON: Record<WorkflowNodeView['status'], string> = { wait: '·', running: '⠿', ok: '✓', failed: '✗' };
const WF_COLOR: Record<WorkflowNodeView['status'], string> = { wait: 'gray', running: 'yellow', ok: 'green', failed: 'red' };

function WorkflowResultPanel({ d }: { d: PanelData & { type: 'workflowResult' } }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>多智能体工作流  <Text dimColor>{d.goal}</Text></Text>
      {d.nodes.map((n) => (
        <Text key={n.id}>{'  '}<Text color={WF_COLOR[n.status]}>{WF_ICON[n.status]}</Text> <Text color="cyan">{n.id}</Text>(<Text dimColor>{n.role}</Text>){n.note ? <Text dimColor>  {n.note}</Text> : null}</Text>
      ))}
      <Box marginTop={1}><Text color="cyanBright" bold>{d.answer}</Text></Box>
      <Text dimColor>{'  '}{d.nodes.length} 个子 agent · {d.ms}ms</Text>
    </Box>
  );
}

/** 分派：按 data.type 选面板组件。 */
export function Panel({ data }: { data: PanelData }) {
  switch (data.type) {
    case 'memory': return <MemoryPanel facts={data.facts} />;
    case 'tokens': return <TokensPanel b={data.breakdown} ctx={data.ctxWindow} />;
    case 'skills': return <SkillsPanel items={data.items} />;
    case 'skillShow': return (
      <Box flexDirection="column">
        <Text><Text color="cyan" bold>{data.name}</Text>  <Text dimColor>{data.description}</Text></Text>
        <Text>{data.body}</Text>
      </Box>
    );
    case 'ledger': return <LedgerPanel d={data} />;
    case 'emergence': return <EmergencePanel report={data.report} />;
    case 'sessions': return <SessionsPanel rows={data.rows} location={data.location} />;
    case 'trace': return <TracePanel entries={data.entries} />;
    case 'history': return <HistoryPanel {...data} />;
    case 'mcp': return <McpPanel servers={data.servers} />;
    case 'consolidate': return <ConsolidatePanel d={data} />;
    case 'planResult': return <PlanResultPanel d={data} />;
    case 'workflowResult': return <WorkflowResultPanel d={data} />;
    default: return null;
  }
}
