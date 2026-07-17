import type { LLMClient, Message, JSONSchema } from '../types.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { WorkflowGraph } from './types.ts';

export class OrchestratorError extends Error {}

/** orchestrator 在 prompt 里列出可用工具（它描述一个引用工具的协作图，不直接调工具）。 */
function describeTools(registry: ToolRegistry): string {
  return registry.toSpecs()
    .map((t) => `- ${t.name}: ${t.description}\n  schema: ${JSON.stringify(t.parameters)}`)
    .join('\n');
}

/** WorkflowGraph 的 JSON schema —— 喂给结构化输出。nodes 内部形态由 verifyGraph 兜底。 */
const GRAPH_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    thought: { type: 'string' },
    goal: { type: 'string' },
    nodes: { type: 'array', items: { type: 'object' } },
    final: { type: 'string' },
  },
  required: ['nodes'],
};

/**
 * 编排器(Orchestrator)与 LLM 的契约,跟 plan 模块的 planner 同源:
 *   LLM 一次性产出一份 WorkflowGraph(JSON),交给确定性 runtime 执行。
 *   区别在于图的节点是「子智能体」而非「工具调用」。
 */
export function orchestratorSystemPrompt(registry: ToolRegistry): string {
  return `你是 LinAgent 的 Orchestrator(编排器)。你把一个复杂任务拆解成多个子智能体(sub-agent)的协作图。
你只做编排,不负责执行。你的输出是一份 WorkflowGraph —— 一个由 agent 节点组成的 DAG,会由确定性 runtime 去执行。

每个子智能体是一个独立的 agent:它有自己的角色、任务指令、可用工具,会自主进行多轮工具调用来完成分配给它的子任务。
子智能体之间通过数据流协作 —— 上游 agent 的最终答复可以喂给下游 agent。

runtime 里所有子智能体共享的可用工具(节点可通过 tools 字段进一步收窄):
${describeTools(registry)}

输出规则:
- 只输出一个 JSON 对象,前后不加任何文字,不加代码围栏。
- 结构:
{
  "thought": "<一两句高层拆解思路>",
  "goal": "<整个工作流的总目标>",
  "nodes": [
    { "id": "researcher", "role": "researcher",
      "instruction": "调研 X,给出要点清单",
      "tools": ["web_search"] },
    { "id": "writer", "role": "writer",
      "instruction": "基于以下调研结果写一段 200 字介绍:\\n{{researcher.result}}",
      "depends_on": ["researcher"] }
  ],
  "final": "{{writer.result}}"
}

规则:
- 每个节点必须有唯一的 id(合法标识符:字母/数字/下划线,以字母或下划线开头)。
- id 也用于引用:在别的节点的 instruction 或 final 里,用 {{节点id.result}} 引用该节点的最终答复。
- 用 depends_on 声明依赖;相互独立的节点不要互相依赖 —— runtime 会自动并行执行它们。
- 引用了 {{X.result}} 就隐含依赖 X,runtime 会等 X 完成后再启动本节点(depends_on 可省略但建议显式写上)。
- tools 字段可选:不填则该子 agent 继承全部可用工具;填了则限制它只能用列出的工具(更聚焦、更安全)。
- final 字段可选:最终答复模板,可引用 {{节点id.result}};省略则默认取拓扑最后一个节点的输出。
- 拆解要克制:只在任务确实能从"分工"中获益时才拆多个节点(如"先研究再写作"、"多个独立子任务并行")。
  简单任务用一个节点即可,不要为拆而拆。
- 不要制造环(A 依赖 B 同时 B 依赖 A)。

示例(并行研究 + 汇总):
{
  "goal": "对比三个城市的天气并给建议",
  "nodes": [
    { "id": "bj", "role": "weather-checker", "instruction": "查北京天气", "tools": ["weather"] },
    { "id": "sh", "role": "weather-checker", "instruction": "查上海天气", "tools": ["weather"] },
    { "id": "advisor", "role": "advisor",
      "instruction": "根据 {{bj.result}} 和 {{sh.result}},用一句话建议今天去哪座城市更舒服",
      "depends_on": ["bj", "sh"] }
  ],
  "final": "{{advisor.result}}"
}`;
}


export interface OrchestrateContext {
  task: string;
  /** 可选:额外的对话历史(如 REPL 上下文)。 */
  history?: Message[];
  onDelta?: (chunk: string) => void;
}

/**
 * 调编排器 LLM,把它的输出解析成 WorkflowGraph。
 * 只做结构层面的解析与最基本校验;完整的图校验(环、悬空依赖等)交给 verifyGraph。
 */
export async function orchestrate(
  llm: LLMClient,
  registry: ToolRegistry,
  ctx: OrchestrateContext,
): Promise<{ graph: WorkflowGraph; raw: string }> {
  const messages: Message[] = [
    { role: 'system', content: orchestratorSystemPrompt(registry) },
    ...(ctx.history ?? []),
    { role: 'user', content: ctx.task },
  ];
  const raw = await llm.complete(messages, {
    temperature: 0.2,
    onDelta: ctx.onDelta,
    jsonSchema: { name: 'WorkflowGraph', schema: GRAPH_SCHEMA },
  });
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new OrchestratorError(`编排器输出解析 JSON 失败:${(err as Error).message}`);
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as WorkflowGraph).nodes)) {
    throw new OrchestratorError('编排器输出缺少 "nodes" 数组');
  }
  const graph = obj as WorkflowGraph;
  if (typeof graph.goal !== 'string' || !graph.goal.trim()) {
    // goal 缺失不致命 —— 用任务本身兜底,避免因小瑕疵重试。
    graph.goal = ctx.task;
  }
  return { graph, raw };
}
