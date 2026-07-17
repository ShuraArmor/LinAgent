import type { LLMClient } from '../types.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { Agent, DEFAULT_AGENT_CONFIG, type ApprovalRequest, type ApprovalDecision } from '../agent.ts';
import type { Session } from '../session.ts';
import { resolveValue, collectRefs } from '../plan/template.ts';
import type { WorkflowGraph, AgentNode, NodeOutcome, WorkflowResult } from './types.ts';

/** run_workflow 工具名 —— 子 agent 的 registry 里始终排除它,防止无限自我编排。 */
export const RUN_WORKFLOW_TOOL = 'run_workflow';

export interface RunnerDeps {
  llm: LLMClient;
  /** 父 registry —— 子 agent 的工具从这里过滤而来。 */
  registry: ToolRegistry;
}

export interface RunnerOptions {
  /** 并发上限,默认 4(与 plan executor 一致)。 */
  maxConcurrency?: number;
  /** 需审批的工具名单,透传给每个子 agent。 */
  requireApproval?: Set<string>;
  /** 审批回调,透传给每个子 agent。 */
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 单个子 agent 的默认循环上限(节点可用 max_turns 覆盖),默认 8。 */
  defaultMaxTurns?: number;
  onNodeStart?: (node: AgentNode) => void;
  onNodeDone?: (outcome: NodeOutcome) => void;
  /** 某节点因上游失败永不启动时触发(每个被跳过的节点一次)。 */
  onNodeSkipped?: (id: string) => void;
}

/**
 * 从父 registry 过滤出一个子 registry。
 *   - allowed 为 undefined → 继承全部工具(但始终排除 run_workflow,防递归)
 *   - allowed 为名单 → 只保留名单内的工具(同样排除 run_workflow)
 */
function buildSubRegistry(parent: ToolRegistry, allowed?: string[]): ToolRegistry {
  const sub = new ToolRegistry();
  const allowSet = allowed ? new Set(allowed) : null;
  for (const tool of parent.list()) {
    if (tool.name === RUN_WORKFLOW_TOOL) continue;      // 防递归
    if (allowSet && !allowSet.has(tool.name)) continue; // 收窄到节点声明的子集
    sub.register(tool);
  }
  return sub;
}

/** 把 NodeOutcome 映射成 template.resolveValue 认识的 { ok, result } 形状。 */
function outcomesToResolveCtx(outcomes: Record<string, NodeOutcome>) {
  const outputs: Record<string, { ok: boolean; result?: unknown; error?: string }> = {};
  for (const [id, o] of Object.entries(outcomes)) {
    outputs[id] = { ok: o.ok, result: o.output, error: o.error };
  }
  return { outputs };
}

/** 构造一个临时的内存 Session(子 agent 用完即弃,不落盘)。 */
function makeEphemeralSession(id: string): Session {
  return { id, title: id, createdAt: 0, history: [], state: {}, trace: [] };
}

/**
 * 执行一份工作流图。
 *
 * 调度模型照搬 plan executor:pending/running 集合 + 依赖满足判定 + 并发上限,
 * 上游失败则不启动下游。区别在于每个节点的"执行"是**跑一个子 agent**:
 * 从父 registry 过滤出受限工具集 → new Agent → 在临时 session 上 chat。
 *
 * 节点间通过 {{node_id.result}} 传数据(result 即上游子 agent 的 finalAnswer)。
 * 全部完成后按 final 模板(或默认末节点输出)拼出最终答复。
 */
export async function runWorkflow(
  graph: WorkflowGraph,
  deps: RunnerDeps,
  opts: RunnerOptions = {},
): Promise<WorkflowResult> {
  const start = Date.now();
  const maxConc = opts.maxConcurrency ?? 4;
  const defaultMaxTurns = opts.defaultMaxTurns ?? 8;

  const outcomes: Record<string, NodeOutcome> = {};
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // 依赖集 = depends_on ∪ instruction 里的 {{ref}}(和 verifyGraph 保持一致)。
  const depsOf = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const d = new Set<string>(node.depends_on ?? []);
    collectRefs(node.instruction, d); // instruction 里的 {{ref}} 也算依赖
    d.delete(node.id);
    depsOf.set(node.id, d);
  }

  const pending = new Set<string>(graph.nodes.map((n) => n.id));
  const running = new Map<string, Promise<void>>();
  let firstFailure: { id: string; reason: string } | undefined;

  const canStart = (id: string): boolean => {
    if (running.has(id) || !pending.has(id)) return false;
    for (const d of depsOf.get(id)!) {
      if (!outcomes[d] || !outcomes[d].ok) return false; // 依赖未完成或失败
    }
    return true;
  };

  const runNode = async (node: AgentNode): Promise<NodeOutcome> => {
    opts.onNodeStart?.(node);
    try {
      // 1) 把 instruction 里的 {{up.result}} 替换成上游输出
      const resolved = resolveValue(node.instruction, outcomesToResolveCtx(outcomes));
      const instruction = typeof resolved === 'string' ? resolved : String(resolved);

      // 2) 受限工具子集
      const subRegistry = buildSubRegistry(deps.registry, node.tools);

      // 3) 构造子 agent(审批门透传)
      const agent = new Agent(deps.llm, subRegistry, {
        ...DEFAULT_AGENT_CONFIG,
        maxTurns: node.max_turns ?? defaultMaxTurns,
        requireApproval: opts.requireApproval,
        approve: opts.approve,
      });

      // 4) 在临时 session 上跑;system 追加节点的角色约束
      const session = makeEphemeralSession(`wf-${node.id}`);
      const roleHint = node.system
        ? `${node.system}\n\n`
        : `你在一个多智能体工作流中担任「${node.role}」角色。专注完成分配给你的子任务。\n\n`;
      const result = await agent.chat(session, roleHint + instruction);

      return { id: node.id, role: node.role, ok: true, output: result.finalAnswer, turns: result.turns };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: node.id, role: node.role, ok: false, error: msg };
    }
  };

  const startNode = (id: string): void => {
    const node = nodeById.get(id)!;
    pending.delete(id);
    const p = runNode(node).then((outcome) => {
      outcomes[id] = outcome;
      opts.onNodeDone?.(outcome);
      if (!outcome.ok && !firstFailure) {
        firstFailure = { id, reason: outcome.error ?? '未知失败' };
      }
      running.delete(id);
    });
    running.set(id, p);
  };

  // 调度主循环(结构照搬 plan executor)
  while (pending.size > 0 || running.size > 0) {
    if (firstFailure) {
      if (running.size === 0) break;
      await Promise.race(running.values());
      continue;
    }
    let launched = 0;
    for (const id of [...pending]) {
      if (running.size >= maxConc) break;
      if (canStart(id)) { startNode(id); launched++; }
    }
    if (launched === 0) {
      if (running.size === 0) break; // 无可启动且无在跑 —— verifyGraph 通过则不该发生
      await Promise.race(running.values());
    } else {
      await Promise.resolve();
    }
  }
  while (running.size > 0) await Promise.race(running.values());

  // 因上游失败而从未启动的节点 → 通知调用方(面板据此标记为跳过)。
  if (firstFailure && pending.size > 0) {
    for (const id of pending) opts.onNodeSkipped?.(id);
  }

  // 拼最终答复
  let answer: string;
  if (typeof graph.final === 'string' && graph.final.trim()) {
    try {
      const r = resolveValue(graph.final, outcomesToResolveCtx(outcomes));
      answer = typeof r === 'string' ? r : JSON.stringify(r);
    } catch (err) {
      answer = `(final 模板解析失败:${(err as Error).message})`;
    }
  } else {
    // 默认取最后一个成功节点的输出
    const succeeded = graph.nodes.map((n) => outcomes[n.id]).filter((o) => o?.ok);
    answer = succeeded.length
      ? succeeded[succeeded.length - 1].output ?? '(无输出)'
      : firstFailure
        ? `工作流失败于节点 "${firstFailure.id}":${firstFailure.reason}`
        : '(工作流没有产出任何输出)';
  }

  return {
    answer,
    graph,
    outcomes,
    metrics: { node_count: graph.nodes.length, elapsed_ms: Date.now() - start },
    failed_node: firstFailure?.id,
  };
}
