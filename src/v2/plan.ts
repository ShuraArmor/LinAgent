/**
 * v2 Plan：runtime 与 LLM 之间的契约。
 *
 * 一份 Plan 是一个由 Step 组成的 DAG。每个 step 要么是 `tool`（工具调用），
 * 要么是 `respond`（终止节点，产出给用户的最终答复）。step 之间通过
 * `depends_on` 描述数据流，还可以带一条可选的 `expect` 后置断言 ——
 * 用一个小 DSL 描述，由 runtime（而不是 LLM）负责求值。
 *
 * 换句话说：LLM 只负责"生成这个数据结构"，runtime 把它当数据用。
 */

export type StepKind = 'tool' | 'respond';

export interface ToolStep {
  id: string;
  kind: 'tool';
  tool: string;
  /**
   * 参数对象。值里可以嵌入形如 `{{step_1.result.city}}` 的模板引用，
   * runtime 会在真正调用工具之前，用前置步骤的输出把它们替换掉。
   */
  args: Record<string, unknown>;
  depends_on?: string[];
  /**
   * 后置断言，在工具执行完成之后由 runtime 求值。语法见 expect.ts 里的迷你 DSL。
   * 断言不通过 → 该步骤标记失败 → 触发 reflector。可选，省略即"尽力而为"。
   */
  expect?: string;
  /** 该步骤的执行时长上限（毫秒）；超时由 executor 强制中断。 */
  budget_ms?: number;
}

export interface RespondStep {
  id: string;
  kind: 'respond';
  /**
   * 最终回答的模板。可以嵌入 `{{step_1.result.x}}` 之类的引用。这是最终展示给
   * 用户的文本 —— LLM 在规划阶段就把它一次性写好，无需再多一次 completion。
   *
   * 若 `synthesize` 为 true，则该字段变为"给综合器 LLM 的短指令"，指令 +
   * 引用步骤的输出会一起交给综合器，模型的输出即为最终答复。
   * 场景：需要跨多个步骤结果做推理（例如"谁最热"），静态模板拼不出来。
   */
  template: string;
  synthesize?: boolean;
  depends_on?: string[];
}

export type Step = ToolStep | RespondStep;

export interface Plan {
  /** LLM 对本次规划的高层推理，仅供 trace 展示，不参与执行。 */
  thought?: string;
  steps: Step[];
  /** 整份 plan 的总执行时长上限。 */
  total_budget_ms?: number;
}

/** reflector 产出的"补丁"：从 `from_id` 起，用 `new_steps` 替换掉后续的所有步骤。 */
export interface PlanPatch {
  thought?: string;
  from_id: string;
  new_steps: Step[];
}
