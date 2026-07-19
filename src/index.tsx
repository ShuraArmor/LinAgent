/**
 * LinAgent 入口（Ink 全屏 UI）。
 *
 * 装配走 buildRuntime（与界面无关）；交互走 Ink。agent 的命令式回调
 * （onDelta/onTrace/...）桥接到 UIStore，App 订阅渲染。
 *
 * P1 范围：loop 对话 + 双流式（思考/正文）+ 基本命令（/exit /help /plan /new）。
 * 审批（P2）、右侧面板（P3）、workflow（P4）、完整命令+plan渲染（P5）后续阶段补。
 */
import React from 'react';
import { render } from 'ink';
import { readFileSync } from 'node:fs';
import { parseCli } from './cli.ts';
import { buildRuntime } from './runtime.ts';
import type { ApprovalRequest, ApprovalDecision } from './agent.ts';
import { UIStore } from './ui/ink/store.ts';
import { App } from './ui/ink/App.tsx';
import { breakdown as tokenBreakdown, breakdownWithSegments, totalTokens, contextWindow, estimateTokensOfMessage } from './tokens.ts';
import { toolResultPreview, compressLine } from './ui/render.ts';
import { renderLedgerWithPrimitives, analyzeEmergence, consolidateLedgerToMemory } from './ledger/index.ts';
import { orchestrate, verifyGraph, runWorkflow, GraphVerifyError } from './workflow/index.ts';
import type { Session } from './session.ts';
import type { Message } from './types.ts';

declare const __APP_VERSION__: string | undefined;
function readVersion(): string {
  if (typeof __APP_VERSION__ === 'string') return __APP_VERSION__;
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

async function main() {
  const config = parseCli(process.argv, readVersion());

  // 审批 + workflow observer：都引用下面才创建的 store，用延迟绑定的占位。
  let approveImpl: (req: ApprovalRequest) => Promise<ApprovalDecision> =
    async () => 'deny';
  // agent 自主调 run_workflow 工具时，把子 agent 状态桥接到 store 的实时块。
  let wfObserverImpl: import('./tools/workflow.ts').WorkflowObserver | undefined;

  let runtime;
  try {
    runtime = await buildRuntime(config, {
      approve: (req) => approveImpl(req),
      workflowObserver: {
        onGraphReady: (g) => wfObserverImpl?.onGraphReady?.(g),
        onNodeStart: (n) => wfObserverImpl?.onNodeStart?.(n),
        onNodeDone: (o) => wfObserverImpl?.onNodeDone?.(o),
        onNodeSkipped: (id) => wfObserverImpl?.onNodeSkipped?.(id),
        onFinish: (result) => wfObserverImpl?.onFinish?.(result),
      },
    });
  } catch (err) {
    process.stderr.write(`\n无法启动: ${(err as Error).message}\n`);
    process.stderr.write('用 --provider/--api-key 旗标，或把 .env.example 复制为 .env 填 LLM_PROVIDER + LLM_API_KEY。\n');
    process.exit(1);
    return;
  }

  const { agent, sessions, registry, llm, home, memStore, userId, ledgerStore,
    skillRegistry, mcpManager, workflowApprovalSet, taskManager } = runtime;
  // llm.name 是协议名（openai/anthropic），真正的 provider 名取自旗标/env。
  const providerName = config.llm.provider ?? process.env.LLM_PROVIDER ?? llm.name;

  let current: Session = sessions.list()[0] ?? sessions.create('window-1');
  if (config.plan) current.state.planMode = true;

  const store = new UIStore({
    turn: 0,
    provider: providerName,
    planMode: Boolean(current.state.planMode),
    busy: false,
    tokensUsed: 0,
    contextWindow: contextWindow(),
    sessionTitle: current.title,
    sessionId: current.id,
  });

  // 审批真实现：弹面板，挂起直到用户选。面板收到选择后 resolve + 关面板。
  approveImpl = (req: ApprovalRequest) => new Promise<ApprovalDecision>((resolve) => {
    store.setApproval({
      toolName: req.toolName,
      args: req.args,
      turn: req.turn,
      resolve: (decision) => { store.setApproval(null); resolve(decision); },
    });
  });

  // workflow observer（agent 自主调 run_workflow 时）→ 桥接到 store 实时块。
  wfObserverImpl = {
    onGraphReady: (g) => store.startWorkflow(g.goal, g.nodes.map((n) => ({ id: n.id, role: n.role }))),
    onNodeStart: (n) => store.updateWorkflowNode(n.id, 'running'),
    onNodeDone: (o) => store.updateWorkflowNode(o.id, o.ok ? 'ok' : 'failed', (o.output ?? o.error ?? '').replace(/\s+/g, ' ').slice(0, 50)),
    onNodeSkipped: (id) => store.updateWorkflowNode(id, 'failed', '上游失败，跳过'),
    onFinish: () => { /* run_workflow 工具的结果由 tool_result 展示；这里只清实时块 */ store.clearWorkflow(); },
  };

  // 开场：LOGO 作为第一条历史（Static 里一次性打印），然后是启动信息。
  store.push('logo', '');
  store.push('system', `LinAgent ${readVersion()}  ·  provider=${providerName}  ·  工具=${registry.list().length}  ·  存储=${home.path} (${home.source})`);
  store.push('system', `会话 ${current.id} (${current.title})  ·  ${current.state.planMode ? 'plan 模式' : 'loop 模式'}`);
  for (const n of runtime.notices) store.push('system', n);
  store.push('system', '输入消息开始对话 · /help 看命令 · /exit 退出');

  // 最近一轮的 system 段快照（system prompt 是每轮临时冻结/拼装的，不写进 history，
  // 所以 token 统计必须从 RunResult 单独拿，否则 system 类别恒为 ~0、总量严重偏低）。
  let lastSeg: { systemBase: string; memory: string; ledger: string } = {
    systemBase: '', memory: '', ledger: '',
  };

  // 计算含 system 段的完整用量分解（system prompt 不在 history 里，须单独计入；
  // 去重逻辑见 breakdownWithSegments）。
  const computeBreakdown = () => breakdownWithSegments(current.history, lastSeg);

  const refreshTokens = () => {
    store.setStatus({ tokensUsed: totalTokens(computeBreakdown()) });
  };

  // ── 处理锁 + 排队（保留原语义：chat 跑时输入进队列，结束按序 drain）──
  let busy = false;
  const pending: string[] = [];
  // 有后台任务完成、待唤醒 agent 处理（onComplete 置起，drain 循环消费）。
  let pendingWake = false;
  // 当轮的打断控制器（Esc 触发 abort）。null=当前空闲、无可打断的轮。
  let currentAbort: AbortController | null = null;
  // 用户已打断本次 pump：drain 循环据此清空队列、停止后续轮，回到空闲。
  let interrupted = false;
  // 流式显示开关（Ink 版流式是核心体验，这里保留 /nostream 命令语义占位）。
  let showStream = config.stream;
  void showStream;

  // chat / wakeChat 共用的 hooks —— 把 agent 的命令式回调桥接到 UIStore。
  // signal 每轮开始时重新赋值（指向当轮的 AbortController），供用户 Esc 打断。
  const chatHooks: import('./agent.ts').ChatHooks = {
    signal: undefined,
    onReasoningDelta: (chunk: string) => store.appendStream('thinking', chunk),
    onDelta: (chunk: string) => store.appendStream('assistant', chunk),
    onTurnStart: (turn: number) => store.setStatus({ turn }),
    onTrace: (entry: import('./types.ts').TraceEntry) => {
      if (entry.kind === 'llm_response') {
        store.endStream();
      } else if (entry.kind === 'tool_call') {
        const d = entry.data as { name?: string; args?: unknown; log?: string };
        if (d.name && !('log' in d)) {
          // 先把当前流式正文落定进 Static，再 push 工具行 —— 保证顺序、消除交叠遮盖。
          store.flushStream();
          store.push('tool_call', `${d.name}(${JSON.stringify(d.args ?? {}).slice(0, 80)})`, d.name);
          store.setActiveTool(d.name);  // 点亮"运行中"动画
        }
      } else if (entry.kind === 'tool_result') {
        const { name, preview } = toolResultPreview(entry.data as never);
        store.push('tool_result', `${name}  ${preview}`, name);
        store.setActiveTool(null);      // 结果到手，熄灭动画
      } else if (entry.kind === 'error') {
        const d = entry.data as { where: string; message: string };
        store.push('error', `[${d.where}] ${d.message}`);
      } else if (entry.kind === 'compress') {
        store.push('compress', compressLine(entry.data as never).replace(/\x1b\[[0-9;]*m/g, ''));
      }
    },
  };

  // 处理一轮 RunResult 的收尾（plan 面板 + 状态刷新 + 落盘）——chat / wakeChat 共用。
  const finishTurn = (res: import('./agent.ts').RunResult) => {
    store.endStream();
    if (res.plan && res.planMetrics) {
      store.pushPanel({
        type: 'planResult',
        goal: current.history.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '',
        steps: res.plan.steps.map((s) => ({
          id: s.id, kind: s.kind,
          detail: s.kind === 'tool' ? s.tool : (s.synthesize ? 'respond·synth' : 'respond'),
        })),
        llmCalls: res.planMetrics.planner_calls + res.planMetrics.reflector_calls,
        elapsedMs: res.planMetrics.elapsed_ms,
      });
    }
    store.setStatus({ turn: res.turns });
    // 捕获本轮 system 段快照，供 token 统计（system prompt 不在 history 里，见 computeBreakdown）。
    // no-op 唤醒轮（turns===0）systemPromptBase 为空 —— 别用空串覆盖掉上一轮的有效快照。
    if (res.turns > 0) {
      lastSeg = {
        systemBase: res.systemPromptBase ?? '',
        memory: res.memoryPrompt ?? '',
        ledger: res.ledgerPrompt ?? '',
      };
    }
    refreshTokens();
    sessions.save(current);
  };

  // ── 一轮对话 ──
  const runChat = async (text: string) => {
    store.push('user', text);
    store.setStatus({ busy: true });
    // 每轮新建打断控制器，挂到 hooks.signal —— Esc 时 abort，agent 立即断流收尾。
    currentAbort = new AbortController();
    chatHooks.signal = currentAbort.signal;

    try {
      // 正文由 onDelta 流式显示、llm_response 时 endStream 提交进历史；finishTurn 只收尾。
      finishTurn(await agent.chat(current, text, chatHooks));
    } catch (err) {
      store.endStream();
      store.push('error', `[agent] ${(err as Error).message}`);
    } finally {
      store.setActiveTool(null);  // 无论正常/异常，收尾都熄灭工具动画
      currentAbort = null;
      chatHooks.signal = undefined;
    }
  };

  // ── 唤醒轮：后台任务完成后，agent 自己醒来处理结果（无用户消息） ──
  const wakeChat = async () => {
    store.setStatus({ busy: true });
    store.push('system', '⚡ 后台任务完成，继续处理…');
    currentAbort = new AbortController();
    chatHooks.signal = currentAbort.signal;
    try {
      const res = await agent.resumeForTasks(current, chatHooks);
      // turns===0 表示 drain 为空（no-op），不刷面板。
      if (res.turns > 0) finishTurn(res);
      else store.endStream();
    } catch (err) {
      store.endStream();
      store.push('error', `[wake] ${(err as Error).message}`);
    } finally {
      store.setActiveTool(null);
      currentAbort = null;
      chatHooks.signal = undefined;
    }
  };

  // ── /workflow 命令：编排多智能体，实时块展示，完成提交进历史 ──
  const runWorkflowCmd = async (task: string) => {
    busy = true;
    store.setStatus({ busy: true });
    const wfStart = Date.now();
    try {
      // 编排 + 校验（失败重试）
      let graph;
      let extraHistory: Message[] = [];
      for (let attempt = 0; attempt <= 2; attempt++) {
        const { graph: g, raw } = await orchestrate(llm, registry, { task, history: extraHistory });
        try { verifyGraph(g, registry); graph = g; break; }
        catch (err) {
          if (!(err instanceof GraphVerifyError)) throw err;
          if (attempt === 2) throw err;
          extraHistory = [
            { role: 'assistant', content: raw },
            { role: 'user', content: `工作流图校验未通过:\n- ${err.issues.join('\n- ')}\n请重新输出修正后的 WorkflowGraph JSON。` },
          ];
        }
      }
      if (!graph) { store.push('error', '未能生成合法的工作流图'); return; }

      store.startWorkflow(graph.goal, graph.nodes.map((n) => ({ id: n.id, role: n.role })));
      const result = await runWorkflow(graph, { llm, registry }, {
        requireApproval: workflowApprovalSet,
        approve: (req) => approveImpl(req),
        onNodeStart: (n) => store.updateWorkflowNode(n.id, 'running'),
        onNodeDone: (o) => store.updateWorkflowNode(o.id, o.ok ? 'ok' : 'failed', (o.output ?? o.error ?? '').replace(/\s+/g, ' ').slice(0, 50)),
        onNodeSkipped: (id) => store.updateWorkflowNode(id, 'failed', '上游失败，跳过'),
      });
      // 把最终状态快照 + 答复提交进历史，清空实时块。
      const snap = store.getWorkflow();
      store.clearWorkflow();
      store.pushPanel({
        type: 'workflowResult',
        goal: graph.goal,
        nodes: snap?.nodes ?? [],
        answer: result.answer,
        ms: Date.now() - wfStart,
      });
    } catch (err) {
      store.clearWorkflow();
      store.push('error', `[workflow] ${(err as Error).message}`);
    } finally {
      busy = false;
      store.setStatus({ busy: false });
    }
  };

  // ── 斜杠命令 ──
  const handleCommand = (cmd: string, rest: string[]): boolean => {
    switch (cmd) {
      case 'exit':
      case 'quit':
        cleanupAndExit();
        return true;
      case 'help':
        store.push('system', '命令: /new /list /switch /rm /plan /memory /skill /tools /ledger /consolidate /emergence /mcp /workflow /tokens /compress /history /trace /reset /help /exit');
        return true;
      case 'plan':
        current.state.planMode = !current.state.planMode;
        sessions.save(current);
        store.setStatus({ planMode: Boolean(current.state.planMode) });
        store.push('system', current.state.planMode ? 'plan 模式已开启 — 先规划再执行' : 'plan 模式已关闭 — 回到 loop');
        return true;
      case 'new': {
        current = sessions.create(rest.join(' ') || undefined);
        if (config.plan) current.state.planMode = true;
        store.clear();
        store.setStatus({ sessionTitle: current.title, sessionId: current.id, planMode: Boolean(current.state.planMode), turn: 0, tokensUsed: 0 });
        store.push('system', `已切换到新会话 ${current.id} (${current.title})`);
        return true;
      }
      case 'reset': {
        const keepPlan = current.state.planMode;
        current.history = [];
        current.state = keepPlan ? { planMode: true } : {};
        current.trace = [];
        agent.invalidateFrozenPrompt(current.id);  // 记忆/账本可能已变，下轮重新冻结
        sessions.save(current);
        store.clear();
        store.setStatus({ turn: 0, tokensUsed: 0 });
        store.push('system', '会话已重置');
        return true;
      }
      case 'list': {
        store.pushPanel({
          type: 'sessions',
          location: sessions.location,
          rows: sessions.list().map((s) => ({
            id: s.id, title: s.title, msgs: s.history.length,
            todos: (s.state.todos as { items?: unknown[] } | undefined)?.items?.length ?? 0,
            active: s.id === current.id,
          })),
        });
        return true;
      }
      case 'switch': {
        const target = rest[0] ? sessions.get(rest[0]) : undefined;
        if (!target) { store.push('error', `没有此会话: ${rest[0] ?? ''}`); return true; }
        current = target;
        store.clear();
        store.setStatus({ sessionTitle: current.title, sessionId: current.id, planMode: Boolean(current.state.planMode), turn: 0 });
        refreshTokens();
        store.push('system', `已切换到 ${current.id} (${current.title})`);
        return true;
      }
      case 'rm': {
        const id = rest[0];
        if (!id) { store.push('error', '用法: /rm <id>'); return true; }
        if (id === current.id) { store.push('error', '不能删除当前会话，请先 /switch'); return true; }
        store.push('system', sessions.delete(id) ? `已删除 ${id}` : `没有此会话: ${id}`);
        return true;
      }
      case 'nostream':
        showStream = !showStream;
        store.push('system', `流式显示: ${showStream ? '开' : '关'}`);
        return true;
      case 'memory':
      case 'mem': {
        const sub = rest[0];
        const mem = memStore.load(userId);
        const alive = mem.facts.filter((f) => !f.superseded_by);
        if (!sub || sub === 'list') {
          store.pushPanel({ type: 'memory', facts: alive.map((f) => ({ id: f.id, layer: f.layer, text: f.text, confidence: f.confidence })) });
        } else if (sub === 'forget') {
          const t = mem.facts.find((f) => f.id === rest[1] && !f.superseded_by);
          if (!t) { store.push('error', `没有活跃的 fact: ${rest[1] ?? ''}`); return true; }
          t.superseded_by = '__forgotten__'; memStore.save(mem);
          store.push('system', `已忘记 ${t.id}: ${t.text}`);
        } else if (sub === 'clear') {
          for (const f of alive) f.superseded_by = '__forgotten__'; memStore.save(mem);
          store.push('system', `已清空 ${alive.length} 条记忆`);
        } else store.push('error', '用法: /memory [list|forget <id>|clear]');
        return true;
      }
      case 'tokens':
      case 'token':
        store.pushPanel({ type: 'tokens', breakdown: computeBreakdown(), ctxWindow: contextWindow() });
        return true;
      case 'history':
      case 'hist': {
        // 查看当前会话的消息序列 —— 压缩后能一眼看出：哪条是保头、哪条是压缩摘要、
        // 尾巴留了哪些。压缩摘要（【已压缩…】）会高亮标注。
        let firstUser = true;
        const rows = current.history.map((m, idx) => {
          const isSummary = m.role === 'system' && m.content.startsWith('【已压缩');
          let tag = m.role as string;
          if (m.role === 'user' && firstUser) { tag = 'head'; firstUser = false; }
          else if (isSummary) tag = 'summary';
          else if (m.role === 'tool' && m.toolName) tag = `tool:${m.toolName}`;
          else if (m.role === 'assistant' && m.toolCalls?.length) tag = `assistant→${m.toolCalls.length}call`;
          const oneLine = m.content.replace(/\s+/g, ' ').trim();
          return {
            idx, role: m.role, tag, isSummary,
            preview: oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine,
            tokens: estimateTokensOfMessage(m),
          };
        });
        store.pushPanel({ type: 'history', rows, total: current.history.length, tokens: totalTokens(tokenBreakdown(current.history)) });
        return true;
      }
      case 'compress': {
        if (busy) { store.push('system', '（正在处理中，请稍候再压缩）'); return true; }
        void (async () => {
          const before = current.history.length;
          try {
            const r = await agent.compressNow(current);
            if (r.compressed) {
              sessions.save(current);
              refreshTokens();
              store.push('system',
                `⚙ 已压缩（${r.conversationClass} 会话）：` +
                `归档 ${r.archived}${r.handle ? `(${r.handle})` : ''} · 合并 ${r.merged} · 删除 ${r.deleted} 条` +
                ` · 历史 ${before}→${current.history.length} 条` +
                ` · 输入 token ${r.beforeTokens}→${r.afterTokens} (省 ${r.savedPct}%)` +
                `${r.handle ? ' · recall_archive 可拉回归档原文' : ''}`);
              if (r.ledgerItems === 0) {
                store.push('system',
                  '⚠ 本次账本为空：压缩只归档了原文、没有结构化摘要留在上下文。' +
                  '让 agent 多用 update_ledger 记录关键结论，压缩后的上下文才有"这段讲了啥"的浓缩（原文仍可 recall_archive 拉回）。');
              }
            } else {
              store.push('system', '（暂无可压缩内容：账本未启用，或历史太短没有可归档的中段）');
            }
          } catch (err) {
            store.push('error', `[compress] ${(err as Error).message}`);
          }
        })();
        return true;
      }
      case 'skill':
      case 'skills': {
        const sub = rest[0];
        if (!sub || sub === 'list') {
          store.pushPanel({ type: 'skills', items: skillRegistry.list().map((s) => ({ name: s.name, description: s.description })) });
        } else if (sub === 'show' || sub === 'load') {
          if (!rest[1]) { store.push('error', '用法: /skill show <name>'); return true; }
          try {
            const s = skillRegistry.load(rest[1]);
            store.pushPanel({ type: 'skillShow', name: s.name, description: s.description, body: s.body });
          } catch (err) { store.push('error', (err as Error).message); }
        } else store.push('error', '用法: /skill [list|show <name>]');
        return true;
      }
      case 'ledger': {
        try {
          const l = ledgerStore.load(current.id, 'zh');
          store.pushPanel({
            type: 'ledger', rendered: renderLedgerWithPrimitives(l),
            turn: l.turn_count, preset: l.preset_used ?? '—',
            updated: new Date(l.updated_at).toLocaleString(),
          });
        } catch (err) { store.push('error', `[ledger] ${(err as Error).message}`); }
        return true;
      }
      case 'emergence': {
        try {
          store.pushPanel({ type: 'emergence', report: analyzeEmergence(ledgerStore.loadAll()) });
        } catch (err) { store.push('error', `[emergence] ${(err as Error).message}`); }
        return true;
      }
      case 'consolidate': {
        try {
          const l = ledgerStore.load(current.id, 'zh');
          const mem = memStore.load(userId);
          const before = mem.facts.filter((f) => !f.superseded_by).length;
          const report = consolidateLedgerToMemory(l, mem, Date.now());
          memStore.save(mem);
          const after = mem.facts.filter((f) => !f.superseded_by).length;
          store.pushPanel({
            type: 'consolidate', before, after,
            candidates: report.candidates, added: report.merge.added.length,
            updated: report.merge.updated.length, superseded: report.merge.superseded.length,
          });
        } catch (err) { store.push('error', `[consolidate] ${(err as Error).message}`); }
        return true;
      }
      case 'mcp': {
        if (!mcpManager || mcpManager.listServers().length === 0) {
          store.pushPanel({ type: 'mcp', servers: [] });
          return true;
        }
        store.pushPanel({
          type: 'mcp',
          servers: mcpManager.status().map((s) => ({
            name: s.name, tools: s.tools, resources: s.resources, prompts: s.prompts,
            toolNames: mcpManager.getServerTools(s.name).map((t) => t.name),
          })),
        });
        return true;
      }
      case 'tools':
      case 'tool': {
        const all = registry.list();
        const name = rest[0];
        if (name) {
          // /tools <name>：单个工具详情（完整描述 + 参数 schema）。
          const t = all.find((x) => x.name === name);
          if (!t) { store.push('error', `未找到工具: ${name}（用 /tools 看全部）`); return true; }
          store.pushPanel({
            type: 'toolShow',
            name: t.name, description: t.description,
            risky: workflowApprovalSet.has(t.name),
            schema: JSON.stringify(t.parameters, null, 2),
          });
          return true;
        }
        // /tools：列出全部工具（名字 + 描述 + 审批标记 + 参数名，必填带 *）。
        const rows = all.map((t) => {
          const props = t.parameters?.properties ?? {};
          const required = new Set(t.parameters?.required ?? []);
          return {
            name: t.name,
            description: t.description,
            risky: workflowApprovalSet.has(t.name),
            params: Object.keys(props).map((p) => (required.has(p) ? `${p}*` : p)),
          };
        });
        store.pushPanel({ type: 'tools', rows, riskyCount: rows.filter((r) => r.risky).length });
        return true;
      }
      case 'trace': {
        store.pushPanel({
          type: 'trace',
          entries: current.trace.slice(-40).map((e) => ({
            kind: e.kind, turn: e.turn, timestamp: e.timestamp,
            summary: JSON.stringify(e.data).slice(0, 80),
          })),
        });
        return true;
      }
      case 'workflow':
      case 'wf': {
        const task = rest.join(' ').trim();
        if (!task) { store.push('system', '用法: /workflow <任务描述>'); return true; }
        if (busy) { store.push('system', '（正在处理中，请稍候再发起 workflow）'); return true; }
        void runWorkflowCmd(task);
        return true;
      }
      default:
        return false;
    }
  };

  const onSubmit = (line: string) => {
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const handled = handleCommand(cmd, rest);
      if (!handled) store.push('system', `（命令 /${cmd} 将在后续阶段接入；当前仅支持核心命令，/help 查看）`);
      return;
    }
    // 普通消息：处理锁 + 排队
    if (busy) { pending.push(line); store.push('system', `⏳ 排队中（共 ${pending.length} 条待处理）`); return; }
    pending.push(line);
    void pump();
  };

  // 处理锁的唯一消费者：串行 drain 用户消息队列 + 后台任务唤醒轮，直到都清空。
  // 单线程保证：同一时刻只有一轮 chat/wakeChat 在跑，不会并发写 session.history。
  const pump = async () => {
    if (busy) return;               // 已有 pump 在跑；它会继续消费队列
    busy = true;
    interrupted = false;            // 新一轮 pump 开始，清打断标志
    store.setStatus({ busy: true });
    try {
      // 先清用户消息，再清唤醒；任一轮跑完可能又产生新的（用户新发/新任务完成），循环到都空。
      // 每步检查 interrupted：用户 Esc 后不再启动下一轮，把排队消息一并丢弃回到空闲。
      while (!interrupted && (pending.length || pendingWake)) {
        while (!interrupted && pending.length) await runChat(pending.shift()!);
        if (interrupted) break;
        if (pendingWake) {
          pendingWake = false;      // 一轮唤醒合并处理所有已完成任务（drain 一次取全部）
          await wakeChat();
        }
      }
    } finally {
      busy = false;
      if (interrupted) {
        // 丢弃打断时仍在排队的消息，明确告知用户；pendingWake 保留（后台任务结果不该丢）。
        const dropped = pending.length;
        pending.length = 0;
        store.push('system', dropped > 0
          ? `⛔ 已打断，丢弃 ${dropped} 条排队消息`
          : '⛔ 已打断');
      }
      interrupted = false;
      store.setStatus({ busy: false });
    }
  };

  // 用户打断（Esc）：中止在途 LLM 请求 + 置起 interrupted 让 pump 停止后续轮。
  // 仅在真的有活跃轮时才响应，避免空闲时误触。
  const onInterrupt = () => {
    if (!busy || !currentAbort) return;
    interrupted = true;
    currentAbort.abort(new Error('用户打断'));
    store.setActiveTool(null);
  };

  // 后台任务完成 → 主动唤醒：置起标志，空闲时立刻 pump（busy 则 pump 结束前的 while 会带上它）。
  taskManager.setOnComplete(() => {
    pendingWake = true;
    void pump();
  });

  // Ctrl-C：连按两次退出
  let sigintAt = 0;
  const onCtrlC = () => {
    const now = Date.now();
    if (now - sigintAt < 1500) { cleanupAndExit(); return; }
    sigintAt = now;
    store.push('system', '（再按一次 Ctrl-C 退出，或输入 /exit）');
  };

  let inkInstance: ReturnType<typeof render> | undefined;
  const cleanupAndExit = () => {
    inkInstance?.unmount();
    void runtime.shutdown().finally(() => {
      process.exit(0);
    });
  };

  inkInstance = render(
    <App store={store} onSubmit={onSubmit} onCtrlC={onCtrlC} onInterrupt={onInterrupt} />,
  );
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});
