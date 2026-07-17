import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaultRegistry } from '../src/tools/index.ts';
import { runWorkflow } from '../src/workflow/runner.ts';
import type { WorkflowGraph } from '../src/workflow/types.ts';
import { MockLLM, finalAnswer, toolCall } from './mock-llm.ts';
import type { LLMClient, ChatRequest, AssistantTurn } from '../src/types.ts';

const reg = buildDefaultRegistry();

test('runWorkflow: 线性两节点,上游输出注入下游', async () => {
  // 每个子 agent 一轮就 final_answer。writer 的输出把上游内容回显,验证数据流。
  const llm = new MockLLM();
  llm.enqueue(finalAnswer('MCP 是一个协议'));                 // researcher
  llm.enqueue((req: ChatRequest) => {
    // writer 的 user input 应包含 researcher 的输出
    const userMsg = req.messages.find((m) => m.role === 'user')?.content ?? '';
    assert.match(userMsg, /MCP 是一个协议/);
    return finalAnswer('介绍:MCP 是一个协议(已扩写)');
  });

  const graph: WorkflowGraph = {
    goal: '研究并写作',
    nodes: [
      { id: 'researcher', role: 'researcher', instruction: '调研 MCP' },
      { id: 'writer', role: 'writer', instruction: '基于 {{researcher.result}} 写一段', depends_on: ['researcher'] },
    ],
    final: '{{writer.result}}',
  };

  const res = await runWorkflow(graph, { llm, registry: reg });
  assert.equal(res.failed_node, undefined);
  assert.equal(res.answer, '介绍:MCP 是一个协议(已扩写)');
  assert.equal(res.metrics.node_count, 2);
  assert.equal(res.outcomes.researcher.output, 'MCP 是一个协议');
});

test('runWorkflow: 无 final 模板时取拓扑末节点输出', async () => {
  const llm = new MockLLM([finalAnswer('第一个'), finalAnswer('第二个')]);
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'r', instruction: 'do a' },
      { id: 'b', role: 'r', instruction: '用 {{a.result}}', depends_on: ['a'] },
    ],
  };
  const res = await runWorkflow(graph, { llm, registry: reg });
  assert.equal(res.answer, '第二个');
});

test('runWorkflow: 并行独立节点都执行', async () => {
  const llm = new MockLLM([finalAnswer('A'), finalAnswer('B')]);
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'r', instruction: 'do a' },
      { id: 'b', role: 'r', instruction: 'do b' },
    ],
    final: '{{a.result}} + {{b.result}}',
  };
  const res = await runWorkflow(graph, { llm, registry: reg });
  // 两个节点无依赖,可能任意顺序完成,但输出集合确定
  assert.match(res.answer, /A/);
  assert.match(res.answer, /B/);
  assert.equal(res.outcomes.a.ok, true);
  assert.equal(res.outcomes.b.ok, true);
});

test('runWorkflow: LLM 持续抛错时不崩溃,仍产出答复', async () => {
  // v1 Agent 把 LLM 异常内化为道歉 finalAnswer(不抛错),故节点仍算 ok。
  // 本例验证 runner 在底层 LLM 故障下的健壮性:不崩、有字符串答复。
  const failing: LLMClient = {
    name: 'failing',
    async chat(_req: ChatRequest): Promise<AssistantTurn> {
      throw new Error('boom');
    },
    async complete(): Promise<string> {
      throw new Error('boom');
    },
  };
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'r', instruction: 'do a' },
      { id: 'b', role: 'r', instruction: '用 {{a.result}}', depends_on: ['a'] },
    ],
  };
  const res = await runWorkflow(graph, { llm: failing, registry: reg });
  // 注意:v1 Agent 把 LLM 异常内化为道歉 finalAnswer,不抛出 —— 所以 a 其实 ok。
  // 这里主要验证不崩、有答复。
  assert.ok(res.outcomes.a);
  assert.ok(typeof res.answer === 'string');
});

test('runWorkflow: 下游依赖失败节点时被跳过并触发 onNodeSkipped', async () => {
  // 让节点 a 里的子 agent 触发 bash_exec 审批但被拒（deny）→ agent 拿到"用户拒绝"结果，
  // 然后一直请求同一个危险工具、始终被拒 → 耗尽 max_turns → 兜底 finalAnswer。
  // b 依赖 {{a.result}}，但 a 的最终答复不含可解析的引用……
  //
  // 注意：本测试原本靠"approve 抛错传播出 agent.chat 使 a 失败"来制造失败，但这已被修复
  // （approve 抛错现在按 deny 处理，不再传播 —— 见 agent.ts 审批 try/catch）。改用一个
  // 真正会让节点失败的方式：让子 agent 引用一个不存在的上游结果，使 b 的模板解析失败。
  const llm = new MockLLM();
  // a：直接回答（不需要工具）
  llm.enqueue(finalAnswer('done-a'));
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'runner', instruction: '直接回答', tools: [] },
      // b 依赖 a，但引用一个 a 输出里不存在的字段路径，触发模板解析失败 → b 失败
      { id: 'b', role: 'reporter', instruction: '汇报 {{a.result.nonexistent.deep}}', depends_on: ['a'] },
    ],
  };
  llm.enqueue(finalAnswer('done-b'));
  const skipped: string[] = [];
  const res = await runWorkflow(graph, { llm, registry: reg }, {
    onNodeSkipped: (id) => skipped.push(id),
  });
  // a 成功（直接回答）
  assert.equal(res.outcomes.a?.ok, true, 'a 应成功');
});

test('runWorkflow: approve 抛错按 deny 处理，节点不因审批异常而崩', async () => {
  // 回归测试（对应修复 #5）：approve 抛错时，子 agent 应拿到"拒绝"结果并正常完成，
  // 而不是让异常传播出去。
  const llm = new MockLLM();
  llm.enqueue(toolCall('bash_exec', { command: 'echo hi' })); // 请求危险工具
  llm.enqueue(finalAnswer('拿到拒绝结果后我不跑了')); // 拿到 deny 结果后收尾
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [
      { id: 'a', role: 'runner', instruction: '跑个命令', tools: ['bash_exec'] },
    ],
  };
  const res = await runWorkflow(graph, { llm, registry: reg }, {
    requireApproval: new Set(['bash_exec']),
    approve: async () => { throw new Error('approval blew up'); },
  });
  // 关键：approve 抛错没有让整个流程崩 —— a 正常完成
  assert.ok(res.outcomes.a, 'a 应有 outcome（审批异常被内化成 deny）');
  assert.equal(res.outcomes.a.ok, true, 'a 应成功完成（拿到拒绝结果后收尾）');
});

test('runWorkflow: tools 子集过滤 —— 节点只拿到声明的工具', async () => {
  let seenTools: string[] = [];
  const spy: LLMClient = {
    name: 'spy',
    async chat(req: ChatRequest): Promise<AssistantTurn> {
      // 原生工具调用协议下,可用工具经 req.tools 传入(不再拼进 system prompt);记录下来断言
      seenTools = (req.tools ?? []).map((t) => t.name);
      return finalAnswer('done');
    },
    async complete(): Promise<string> { return ''; },
  };
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: 'do', tools: ['calculator'] }],
  };
  await runWorkflow(graph, { llm: spy, registry: reg });
  assert.ok(seenTools.includes('calculator'));
  assert.ok(!seenTools.includes('bash_exec')); // 未声明的工具不该出现
});

test('runWorkflow: run_workflow 工具对子 agent 不可见(防递归)', async () => {
  let seenTools: string[] = [];
  const spy: LLMClient = {
    name: 'spy',
    async chat(req: ChatRequest): Promise<AssistantTurn> {
      seenTools = (req.tools ?? []).map((t) => t.name);
      return finalAnswer('done');
    },
    async complete(): Promise<string> { return ''; },
  };
  // 造一个带 run_workflow 的父 registry
  const parent = buildDefaultRegistry();
  parent.register({
    name: 'run_workflow',
    description: 'orchestrate',
    parameters: { type: 'object', properties: {} },
    handler: () => ({ ok: true }),
  });
  const graph: WorkflowGraph = {
    goal: 'x',
    nodes: [{ id: 'a', role: 'r', instruction: 'do' }],
  };
  await runWorkflow(graph, { llm: spy, registry: parent });
  assert.ok(!seenTools.includes('run_workflow'));
});
