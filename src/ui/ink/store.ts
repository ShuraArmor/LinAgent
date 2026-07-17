/**
 * UI 状态容器 —— agent 的命令式回调（onDelta/onTrace/...）在 React 之外触发，
 * 这里把它们收集成可订阅的 state，App 用 useSyncExternalStore 映射成渲染。
 *
 * 抗抖动架构（关键）：把历史拆成两块——
 *   - committed[]：已完成、不再变化的条目。走 Ink 的 <Static>，只渲染一次、
 *     永不参与逐帧重绘。引用只在 append 时变。
 *   - streaming：当前正在逐字追加的那一条（thinking / assistant）。放在 Static
 *     下方的动态区，每帧重绘，但高度受控（就一条）→ 不会触发全屏擦除重画。
 * 流式结束时把 streaming「提交」进 committed，动态区清空。
 *
 * 为什么这么做：Ink 是「擦上一帧、重画整帧」模型；一旦整帧高度 > 终端行数，
 * 它退化成 clearTerminal（\e[2J\e[3J）全屏重画，逐字流式时每个 chunk 触发一次 →
 * 剧烈上下抖动。把历史移出重绘范围（交给 Static），每帧真正重绘的内容就 < 一屏。
 */

import type { PanelData, WorkflowNodeView } from './panels/types.ts';

export type EntryKind =
  | 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result'
  | 'error' | 'compress' | 'system' | 'final' | 'logo' | 'panel';

export interface HistoryEntry {
  id: number;
  kind: EntryKind;
  text: string;
  /** kind==='panel' 时携带的结构化面板数据快照。 */
  panel?: PanelData;
  /** kind==='tool_call'/'tool_result' 时携带的工具名，用于按工具着色/选图标。 */
  toolName?: string;
}

export interface StatusState {
  turn: number;
  provider: string;
  planMode: boolean;
  busy: boolean;
  tokensUsed: number;
  contextWindow: number;
  sessionTitle: string;
  sessionId: string;
}

/** 当前流式条目（动态区渲染，未提交进 Static）。 */
export interface StreamingEntry {
  kind: 'thinking' | 'assistant';
  text: string;
}

type Listener = () => void;

export class UIStore {
  // 已提交历史：走 <Static>，引用只在 append 时变。
  private committed: HistoryEntry[] = [];
  // 流式中的那一条（动态区）。
  private streaming: StreamingEntry | null = null;
  private status: StatusState;
  private listeners = new Set<Listener>();
  private nextId = 1;

  // 节流：合并高频 emit（流式逐 token），~30fps。
  private emitScheduled = false;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initial: StatusState) {
    this.status = initial;
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** 立即 emit（状态变更等需要即时反馈的场景）。 */
  private emitNow() { for (const l of this.listeners) l(); }

  /** 节流 emit（流式追加用）——合并一帧内的多次追加。 */
  private emitThrottled() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    this.emitTimer = setTimeout(() => { this.emitScheduled = false; this.emitTimer = null; this.emitNow(); }, 32);
  }

  /** 取消挂起的节流 emit —— 立即提交（endStream / flush）前调，避免提交后残留一次空 emit。 */
  private cancelThrottle() {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.emitScheduled = false;
  }

  getCommitted = (): HistoryEntry[] => this.committed;
  getStreaming = (): StreamingEntry | null => this.streaming;
  getStatus = (): StatusState => this.status;

  // ── 写入 API ──

  /** 追加一条完整（已完成）条目，直接进 Static。toolName 用于工具条目着色。 */
  push(kind: EntryKind, text: string, toolName?: string): number {
    const id = this.nextId++;
    this.committed = [...this.committed, { id, kind, text, toolName }];
    this.emitNow();
    return id;
  }

  /** 追加一条结构化面板条目（进 Static，快照不变、不重绘）。 */
  pushPanel(panel: PanelData): number {
    const id = this.nextId++;
    this.committed = [...this.committed, { id, kind: 'panel', text: '', panel }];
    this.emitNow();
    return id;
  }

  /**
   * 往流式条目追加文本。kind 切换（思考→正文）时，先把上一条流式提交进 Static，
   * 再开新的。用节流 emit，避免逐 token 全量重绘。
   */
  appendStream(kind: 'thinking' | 'assistant', chunk: string): void {
    if (this.streaming && this.streaming.kind !== kind) {
      this.commitStreaming();
    }
    if (!this.streaming) {
      this.streaming = { kind, text: '' };
    }
    this.streaming = { kind, text: this.streaming.text + chunk };
    this.emitThrottled();
  }

  /** 把当前流式条目提交进 Static（成为不可变历史），清空动态区。 */
  private commitStreaming(): void {
    if (!this.streaming) return;
    const id = this.nextId++;
    this.committed = [...this.committed, { id, kind: this.streaming.kind, text: this.streaming.text }];
    this.streaming = null;
  }

  /** 结束流式：提交 + 立即刷新（不节流，保证收尾即时可见）。 */
  endStream(): void {
    if (!this.streaming) return;
    this.cancelThrottle();   // 清掉挂起的节流 emit，避免提交后又空刷一次造成交叠
    this.commitStreaming();
    this.emitNow();
  }

  /**
   * 强制 flush 当前流式：把正在流的那条立即提交进 Static，动态区清空。
   * 工具调用到来时先调它 —— 保证"流式文本先落定、工具行再接在后面"，
   * 消除"流式动态区还在显示 vs 工具行已进 Static"的交叠竞态（互相遮盖/乱跳的根因）。
   * 与 endStream 的区别：语义上 endStream 是"这轮说完了"，flushStream 是"被打断、先存下"。
   * 实现相同，但分开命名让调用点意图清晰。
   */
  flushStream(): void {
    this.endStream();
  }

  setStatus(patch: Partial<StatusState>): void {
    this.status = { ...this.status, ...patch };
    this.emitNow();
  }

  /** 清空历史（/reset / /new）。 */
  clear(): void {
    this.committed = [];
    this.streaming = null;
    this.emitNow();
  }

  // ── workflow 实时状态（动态区，类似 streaming）──
  private workflow: { goal: string; nodes: WorkflowNodeView[] } | null = null;
  getWorkflow = (): { goal: string; nodes: WorkflowNodeView[] } | null => this.workflow;

  /** 开一个 workflow 实时块（节点初始全 wait）。 */
  startWorkflow(goal: string, nodes: { id: string; role: string }[]): void {
    this.workflow = { goal, nodes: nodes.map((n) => ({ ...n, status: 'wait' })) };
    this.emitNow();
  }

  /** 更新某个节点状态（节流 emit）。 */
  updateWorkflowNode(id: string, status: WorkflowNodeView['status'], note?: string): void {
    if (!this.workflow) return;
    this.workflow = {
      ...this.workflow,
      nodes: this.workflow.nodes.map((n) => (n.id === id ? { ...n, status, note: note ?? n.note } : n)),
    };
    this.emitThrottled();
  }

  /** 清空 workflow 动态块（结果已提交进历史后调）。 */
  clearWorkflow(): void {
    this.workflow = null;
    this.emitNow();
  }

  // ── 审批面板 ──
  private approval: ApprovalPrompt | null = null;
  getApproval = (): ApprovalPrompt | null => this.approval;
  setApproval(p: ApprovalPrompt | null): void {
    this.approval = p;
    this.emitNow();
  }

  // ── 当前正在运行的工具（动态区展示带动画的"运行中"指示）──
  private activeTool: string | null = null;
  getActiveTool = (): string | null => this.activeTool;
  /** 标记某工具开始运行（tool_call 时调），或清空（null）。 */
  setActiveTool(name: string | null): void {
    this.activeTool = name;
    this.emitNow();
  }
}

export interface ApprovalPrompt {
  toolName: string;
  args: Record<string, unknown>;
  turn: number;
  resolve: (decision: 'approve' | 'approve_session' | 'deny') => void;
}
