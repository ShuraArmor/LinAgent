import type { WorkflowGraph } from './types.ts';
import { collectRefs } from '../plan/template.ts';
import type { ToolRegistry } from '../tools/registry.ts';

export class GraphVerifyError extends Error {
  constructor(public readonly summary: string, public readonly issues: string[]) {
    super(`${summary}: ${issues.join('; ')}`);
  }
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface GraphVerifyResult {
  /** 节点 id 的拓扑顺序。 */
  order: string[];
}

/**
 * 在 runner 执行之前对工作流图做静态检查(仿 plan 模块的 verifier.ts):
 *   1. 至少一个节点;每个节点 id 合法且唯一;role / instruction 非空
 *   2. 所有 depends_on 指向已知节点
 *   3. instruction 里的 {{ref}} 引用都指向已知节点
 *   4. 节点声明的 tools 都在 registry 里存在
 *   5. final 模板里的 {{ref}} 都指向已知节点
 *   6. 无环(Kahn 拓扑排序)
 *
 * 校验失败抛 GraphVerifyError(带 issues 数组),供编排器重试。
 */
export function verifyGraph(graph: WorkflowGraph, registry: ToolRegistry): GraphVerifyResult {
  const issues: string[] = [];
  const push = (m: string) => issues.push(m);

  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new GraphVerifyError('工作流至少需要一个节点', ['empty graph']);
  }

  // (1) id 合法且唯一;role / instruction 非空
  const idSet = new Set<string>();
  for (const node of graph.nodes) {
    if (typeof node.id !== 'string' || !ID_RE.test(node.id)) {
      push(`非法节点 id: ${JSON.stringify(node.id)}`);
    }
    if (idSet.has(node.id)) push(`重复的节点 id: ${node.id}`);
    idSet.add(node.id);
    if (typeof node.role !== 'string' || !node.role.trim()) {
      push(`节点 "${node.id}" 缺少 role`);
    }
    if (typeof node.instruction !== 'string' || !node.instruction.trim()) {
      push(`节点 "${node.id}" 缺少 instruction`);
    }
  }

  // (2)+(3) depends_on 与 instruction 引用指向已知节点
  for (const node of graph.nodes) {
    for (const d of node.depends_on ?? []) {
      if (!idSet.has(d)) push(`节点 "${node.id}" 依赖未知节点 "${d}"`);
    }
    const refs = collectRefs(node.instruction);
    for (const r of refs) {
      if (!idSet.has(r)) push(`节点 "${node.id}" 的 instruction 引用了未知节点 "${r}"`);
    }
  }

  // (4) tools 都存在
  for (const node of graph.nodes) {
    for (const t of node.tools ?? []) {
      if (!registry.has(t)) push(`节点 "${node.id}" 声明了未知工具 "${t}"`);
    }
  }

  // (5) final 模板引用
  if (typeof graph.final === 'string' && graph.final.trim()) {
    for (const r of collectRefs(graph.final)) {
      if (!idSet.has(r)) push(`final 模板引用了未知节点 "${r}"`);
    }
  }

  // (6) 无环 —— Kahn 拓扑排序(依赖来源:depends_on + instruction 里的 {{ref}})
  const inbound: Record<string, Set<string>> = {};
  for (const node of graph.nodes) {
    const deps = new Set<string>();
    for (const d of node.depends_on ?? []) deps.add(d);
    collectRefs(node.instruction, deps);
    deps.delete(node.id);
    // 只保留已知 id,避免"未知引用"与"存在环"重复报错。
    inbound[node.id] = new Set([...deps].filter((d) => idSet.has(d)));
  }

  const order: string[] = [];
  const remainingIn: Record<string, number> = {};
  for (const [id, deps] of Object.entries(inbound)) remainingIn[id] = deps.size;
  const queue: string[] = Object.entries(remainingIn).filter(([, n]) => n === 0).map(([id]) => id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const node of graph.nodes) {
      if (inbound[node.id].has(id)) {
        inbound[node.id].delete(id);
        remainingIn[node.id] -= 1;
        if (remainingIn[node.id] === 0) queue.push(node.id);
      }
    }
  }
  if (order.length !== graph.nodes.length) {
    const stuck = graph.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    push(`节点间存在环 (cycle): ${stuck.join(', ')}`);
  }

  if (issues.length) throw new GraphVerifyError(`工作流校验失败,共 ${issues.length} 处问题`, issues);
  return { order };
}
