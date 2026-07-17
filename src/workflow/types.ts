/**
 * 多智能体工作流(Workflow)—— runtime 与"编排器 LLM"之间的契约。
 *
 * 这是 plan 模式 DAG 抽象再上一层的产物:
 *   plan 模式里 DAG 的节点是一次「工具调用」;
 *   workflow 里 DAG 的节点是一个「子智能体」—— 带独立角色、指令、受限工具集。
 *
 * 编排器 LLM 只负责「生成这张图」这个数据结构,runtime(runner.ts)把它当数据
 * 确定性地执行:拓扑调度、能并行就并行、节点间用 {{node_id.result}} 传数据。
 * 设计哲学与 plan 模块的 planner/executor 一致。
 */

/** 工作流里的一个子智能体节点。 */
export interface AgentNode {
  /** 节点唯一标识(合法标识符,用于 depends_on 和 {{id.result}} 引用)。 */
  id: string;
  /** 人类可读的角色名,如 "researcher"、"writer"。仅用于展示与 system 提示。 */
  role: string;
  /**
   * 该子 agent 要完成的任务 —— 会作为它的 user input。
   * 可嵌入 {{node_id.result}} 引用上游节点的最终答复,runtime 在启动前替换。
   */
  instruction: string;
  /** 可选:附加在该子 agent system prompt 上的额外角色约束。 */
  system?: string;
  /**
   * 可选:该子 agent 允许使用的工具名单。
   * 不填 = 继承父 registry 的全部工具(但始终排除 run_workflow,防止无限自我编排)。
   */
  tools?: string[];
  /** 依赖的上游节点 id;这些节点全部成功后本节点才会启动。 */
  depends_on?: string[];
  /** 该子 agent 的循环轮次上限,默认 8。 */
  max_turns?: number;
}

/** 一份完整的工作流图。 */
export interface WorkflowGraph {
  /** 编排器的高层推理,仅供展示。 */
  thought?: string;
  /** 整个工作流的总目标。 */
  goal: string;
  /** 子智能体节点集合(构成一个 DAG)。 */
  nodes: AgentNode[];
  /**
   * 可选:最终答复模板,可引用 {{node_id.result}}。
   * 省略则默认取拓扑顺序最后一个节点的 output 作为最终答复。
   */
  final?: string;
}

/** 单个节点执行完的结果。 */
export interface NodeOutcome {
  id: string;
  role: string;
  ok: boolean;
  /** 子 agent 的最终答复(finalAnswer)。 */
  output?: string;
  /** 失败原因。 */
  error?: string;
  /** 子 agent 实际用掉的轮次。 */
  turns?: number;
}

/** 整个工作流执行完的结果。 */
export interface WorkflowResult {
  answer: string;
  graph: WorkflowGraph;
  outcomes: Record<string, NodeOutcome>;
  metrics: { node_count: number; elapsed_ms: number };
  /** 第一个失败节点的 id(若有)。 */
  failed_node?: string;
}
