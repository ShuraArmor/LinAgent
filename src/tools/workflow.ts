import type { LLMClient, Message, Tool } from '../types.ts';
import type { ToolRegistry } from './registry.ts';
import type { ApprovalRequest, ApprovalDecision } from '../agent.ts';
import { orchestrate } from '../workflow/orchestrator.ts';
import { verifyGraph, GraphVerifyError } from '../workflow/verify.ts';
import { runWorkflow } from '../workflow/runner.ts';
import type { WorkflowGraph, AgentNode, NodeOutcome, WorkflowResult } from '../workflow/types.ts';

/**
 * 工作流生命周期观察者。REPL 层通过它把工具内部的节点事件接到多行状态面板上——
 * 这样"主 agent 在对话里自主调用 run_workflow"也能看到实时面板,而不只是单行 spinner。
 * 所有钩子都是可选的、纯展示用,不影响执行。
 */
export interface WorkflowObserver {
  /** 编排 + 校验完成、即将执行时触发,携带最终的图(REPL 据此创建面板)。 */
  onGraphReady?(graph: WorkflowGraph): void;
  onNodeStart?(node: AgentNode): void;
  onNodeDone?(outcome: NodeOutcome): void;
  onNodeSkipped?(id: string): void;
  /** 全部执行完毕触发(无论成败),REPL 据此收尾面板。 */
  onFinish?(result: WorkflowResult): void;
}

export interface RunWorkflowToolDeps {
  llm: LLMClient;
  /** 父 registry(子 agent 的工具从这里过滤;应含全部工具,包含 MCP 工具)。 */
  registry: ToolRegistry;
  requireApproval?: Set<string>;
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 编排器产出的图校验失败时,允许它重新编排的最大次数,默认 2。 */
  maxVerifyRetries?: number;
  /** 可选:生命周期观察者,供 REPL 挂接实时面板。 */
  observer?: WorkflowObserver;
}

/**
 * 构造 run_workflow 工具。
 *
 * 用工厂函数是因为工具 handler 需要访问 llm 和 registry —— 这两者无法从 ToolContext
 * 拿到,故用闭包捕获(与 mcp/tools.ts 的 buildMCPResourceTool(manager) 同一模式)。
 *
 * 流程:orchestrate(LLM 生成 agent-graph) → verifyGraph(校验,失败让编排器重试)
 *      → runWorkflow(确定性执行多个子 agent)。
 */
export function buildRunWorkflowTool(deps: RunWorkflowToolDeps): Tool {
  const maxRetries = deps.maxVerifyRetries ?? 2;

  return {
    name: 'run_workflow',
    description:
      '把一个复杂任务交给多智能体工作流:自动拆解成多个子 agent(各有角色和工具)、' +
      '按依赖并行/串行执行、节点间传递数据,最后汇总答复。适合"先研究再写作""多个独立子任务并行汇总"这类需要分工的任务。参数 task 是要完成的整体任务描述。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要完成的整体任务描述(自然语言)。' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const task = String(args.task ?? '').trim();
      if (!task) return { ok: false, error: 'task 不能为空' };

      // ── 编排 + 校验(校验失败让编排器重来) ──────────────────
      let graph;
      let extraHistory: Message[] = [];
      let lastIssues: string[] = [];
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const { graph: g, raw } = await orchestrate(deps.llm, deps.registry, {
          task, history: extraHistory,
        });
        try {
          verifyGraph(g, deps.registry);
          graph = g;
          break;
        } catch (err) {
          if (!(err instanceof GraphVerifyError)) throw err;
          lastIssues = err.issues;
          if (attempt === maxRetries) {
            return { ok: false, error: `工作流图校验连续失败:${lastIssues.join('; ')}` };
          }
          extraHistory = [
            { role: 'assistant', content: raw },
            {
              role: 'user',
              content: `你上一份工作流图校验未通过,问题如下:\n- ${lastIssues.join('\n- ')}\n请重新输出一份修正后的 WorkflowGraph JSON。`,
            },
          ];
        }
      }

      if (!graph) return { ok: false, error: '未能生成合法的工作流图' };

      // ── 执行(审批门透传给每个子 agent) ────────────────────
      const obs = deps.observer;
      ctx.logger(`workflow: 编排出 ${graph.nodes.length} 个子 agent — ${graph.nodes.map((n) => n.role).join(', ')}`);
      obs?.onGraphReady?.(graph);
      const result = await runWorkflow(graph, { llm: deps.llm, registry: deps.registry }, {
        requireApproval: deps.requireApproval,
        approve: deps.approve,
        onNodeStart: (n) => obs?.onNodeStart?.(n),
        onNodeDone: (o) => {
          ctx.logger(`workflow: 节点 "${o.id}"(${o.role})${o.ok ? '完成' : '失败'}`);
          obs?.onNodeDone?.(o);
        },
        onNodeSkipped: (id) => obs?.onNodeSkipped?.(id),
      });
      obs?.onFinish?.(result);

      return {
        ok: !result.failed_node,
        answer: result.answer,
        goal: graph.goal,
        node_count: result.metrics.node_count,
        roles: graph.nodes.map((n) => n.role),
        failed_node: result.failed_node,
      };
    },
  };
}
