import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, DEFAULT_AGENT_CONFIG, type ApprovalDecision } from '../src/agent.ts';
import { SessionManager } from '../src/session.ts';
import { buildDefaultRegistry, setSandboxRoot } from '../src/tools/index.ts';
import { MockLLM, toolCall, finalAnswer } from './mock-llm.ts';

const cfg = { ...DEFAULT_AGENT_CONFIG, useLLMCompression: false, maxTurns: 4 };

function mkSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'linagent-approval-'));
  setSandboxRoot(dir);
  return dir;
}

test('approval: deny → 工具不执行，错误回喂给 LLM', async () => {
  const dir = mkSandbox();
  try {
    const llm = new MockLLM([
      toolCall('fs_write', { path: 'evil.txt', content: 'x' }),
      finalAnswer('已被拒绝，未写入'),
    ]);
    let asked = 0;
    const approve = async (): Promise<ApprovalDecision> => { asked++; return 'deny'; };
    const agent = new Agent(llm, buildDefaultRegistry(), {
      ...cfg,
      requireApproval: new Set(['fs_write', 'fs_delete']),
      approve,
    });
    const s = new SessionManager().create();
    await agent.chat(s, '写一个文件');
    assert.equal(asked, 1);
    assert.ok(!existsSync(join(dir, 'evil.txt')));
    // 工具错误应记进 trace
    const err = s.trace.find((t) => t.kind === 'error'
      && (t.data as { where: string; kind: string }).kind === 'denied');
    assert.ok(err);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval: approve → 工具执行', async () => {
  const dir = mkSandbox();
  try {
    const llm = new MockLLM([
      toolCall('fs_write', { path: 'ok.txt', content: 'hello' }),
      finalAnswer('已写入'),
    ]);
    const approve = async (): Promise<ApprovalDecision> => 'approve';
    const agent = new Agent(llm, buildDefaultRegistry(), {
      ...cfg,
      requireApproval: new Set(['fs_write']),
      approve,
    });
    const s = new SessionManager().create();
    await agent.chat(s, '写一个文件');
    assert.ok(existsSync(join(dir, 'ok.txt')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval: approve_session → 后续同一工具无需再审批', async () => {
  const dir = mkSandbox();
  try {
    const llm = new MockLLM([
      toolCall('fs_write', { path: 'a.txt', content: '1' }),
      toolCall('fs_write', { path: 'b.txt', content: '2' }),
      finalAnswer('都写了'),
    ]);
    let asked = 0;
    const approve = async (): Promise<ApprovalDecision> => { asked++; return 'approve_session'; };
    const agent = new Agent(llm, buildDefaultRegistry(), {
      ...cfg,
      requireApproval: new Set(['fs_write']),
      approve,
    });
    const s = new SessionManager().create();
    await agent.chat(s, '连写两个文件');
    // 只应被问一次
    assert.equal(asked, 1);
    assert.ok(existsSync(join(dir, 'a.txt')));
    assert.ok(existsSync(join(dir, 'b.txt')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval: 未配置 approve 回调 → fail-closed 默认拒绝', async () => {
  const dir = mkSandbox();
  try {
    const llm = new MockLLM([
      toolCall('fs_write', { path: 'x.txt', content: 'x' }),
      finalAnswer('拒了'),
    ]);
    const agent = new Agent(llm, buildDefaultRegistry(), {
      ...cfg,
      requireApproval: new Set(['fs_write']),
      // 故意不给 approve
    });
    const s = new SessionManager().create();
    await agent.chat(s, '写文件');
    assert.ok(!existsSync(join(dir, 'x.txt')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('approval: 未列入 requireApproval 的工具不会走审批', async () => {
  const dir = mkSandbox();
  try {
    const llm = new MockLLM([
      toolCall('fs_read', { path: 'anything.txt' }),
      finalAnswer('done'),
    ]);
    let asked = 0;
    const approve = async (): Promise<ApprovalDecision> => { asked++; return 'deny'; };
    const agent = new Agent(llm, buildDefaultRegistry(), {
      ...cfg,
      requireApproval: new Set(['fs_write']),  // 只审批写入
      approve,
    });
    const s = new SessionManager().create();
    await agent.chat(s, '读文件');
    assert.equal(asked, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
