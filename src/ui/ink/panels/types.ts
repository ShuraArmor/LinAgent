/**
 * 命令面板的数据快照类型（判别联合）。
 *
 * 关键：这些是 push 进历史时生成的**不可变快照**，之后不再变 —— 所以能安全进
 * <Static>，不参与逐帧重绘。面板组件是纯展示：吃快照 → 渲染，无内部状态。
 */
import type { CategoryBreakdown } from '../../../tokens.ts';
import type { EmergenceReport } from '../../../ledger/index.ts';
import type { MemoryLayer } from '../../../memory.ts';

export interface MemoryFactView {
  id: string;
  layer: MemoryLayer;
  text: string;
  confidence: number;
}

export interface SessionRowView {
  id: string;
  title: string;
  msgs: number;
  todos: number;
  active: boolean;
}

export interface TraceEntryView {
  kind: string;
  turn: number;
  timestamp: number;
  summary: string;
}

export interface McpServerView {
  name: string;
  tools: number;
  resources: number;
  prompts: number;
  toolNames: string[];
}

export interface WorkflowNodeView {
  id: string;
  role: string;
  status: 'wait' | 'running' | 'ok' | 'failed';
  note?: string;
}

export type PanelData =
  | { type: 'memory'; facts: MemoryFactView[] }
  | { type: 'tokens'; breakdown: CategoryBreakdown; ctxWindow: number }
  | { type: 'skills'; items: { name: string; description: string }[] }
  | { type: 'skillShow'; name: string; description: string; body: string }
  | { type: 'ledger'; rendered: string; turn: number; preset: string; updated: string }
  | { type: 'emergence'; report: EmergenceReport }
  | { type: 'sessions'; rows: SessionRowView[]; location: string }
  | { type: 'trace'; entries: TraceEntryView[] }
  | { type: 'mcp'; servers: McpServerView[] }
  | { type: 'consolidate'; before: number; after: number; candidates: number; added: number; updated: number; superseded: number }
  | { type: 'planResult'; goal: string; steps: { id: string; kind: string; detail: string }[]; llmCalls: number; elapsedMs: number }
  | { type: 'workflowResult'; goal: string; nodes: WorkflowNodeView[]; answer: string; ms: number }
  | { type: 'history'; rows: HistoryRowView[]; total: number; tokens: number };

/** 一条 history 消息的展示行（用于 /history 面板查看压缩后的会话形态）。 */
export interface HistoryRowView {
  idx: number;
  role: string;
  /** 展示用标签：head（保头）/ summary（压缩摘要）/ tool 名 等。 */
  tag: string;
  /** 内容预览（已截断）。 */
  preview: string;
  tokens: number;
  /** 是否是压缩摘要消息（渲染时高亮）。 */
  isSummary: boolean;
}
