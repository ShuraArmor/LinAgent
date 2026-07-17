import type {
  LLMChatOpts, LLMClient, Message, ChatRequest, AssistantTurn, ToolCallRequest,
} from '../src/types.ts';

/**
 * chat() 的脚本回复：要么直接是 AssistantTurn，要么是个函数按 (req, turn) 产出。
 * complete() 的脚本回复：字符串或函数。
 */
export type MockTurn = AssistantTurn | ((req: ChatRequest, turn: number) => AssistantTurn);
export type MockText = string | ((messages: Message[], turn: number) => string);

/**
 * 脚本化 LLM。
 * - chat()：从 turnQueue 取下一个 AssistantTurn（结构化工具调用协议）
 * - complete()：从 textQueue 取下一个字符串（摘要 / synthesize / 结构化输出）
 *
 * 两条队列独立，因为 agent 主循环走 chat、摘要/planner 走 complete。
 */
export class MockLLM implements LLMClient {
  readonly name = 'mock';
  public calls: Array<Message[]> = [];        // chat 每次调用的 messages
  public completeCalls: Array<Message[]> = []; // complete 每次调用的 messages
  private turnQueue: MockTurn[] = [];
  private textQueue: MockText[] = [];

  constructor(initial?: MockTurn[]) {
    if (initial) this.turnQueue.push(...initial);
  }

  /** 入队一个 chat 回合。 */
  enqueue(turn: MockTurn): void {
    this.turnQueue.push(turn);
  }

  enqueueMany(turns: MockTurn[]): void {
    this.turnQueue.push(...turns);
  }

  /** 入队一个 complete 文本回复（摘要 / synthesize / 结构化输出场景）。 */
  enqueueText(text: MockText): void {
    this.textQueue.push(text);
  }

  enqueueTexts(texts: MockText[]): void {
    this.textQueue.push(...texts);
  }

  async chat(req: ChatRequest): Promise<AssistantTurn> {
    this.calls.push(req.messages);
    const next = this.turnQueue.shift();
    if (next === undefined) throw new Error('MockLLM: chat queue is empty');
    const turn = typeof next === 'function' ? next(req, this.calls.length) : next;
    // 模拟流式：把 text 分片喂给 onDelta
    if (req.onDelta && turn.text) {
      for (let i = 0; i < turn.text.length; i += 8) {
        req.onDelta(turn.text.slice(i, i + 8));
      }
    }
    return turn;
  }

  async complete(messages: Message[], opts?: LLMChatOpts): Promise<string> {
    this.completeCalls.push(messages);
    const next = this.textQueue.shift();
    if (next === undefined) throw new Error('MockLLM: complete queue is empty');
    const text = typeof next === 'function' ? next(messages, this.completeCalls.length) : next;
    if (opts?.onDelta) {
      for (let i = 0; i < text.length; i += 8) opts.onDelta(text.slice(i, i + 8));
    }
    return text;
  }
}

let mockCallId = 0;
function nextCallId(): string {
  mockCallId += 1;
  return `call_mock_${mockCallId}`;
}

/** 造一个"调用工具"的 AssistantTurn。text 是可选的伴随文本（旧的 thought）。 */
export function toolCall(name: string, args: Record<string, unknown>, text = ''): AssistantTurn {
  const call: ToolCallRequest = { id: nextCallId(), name, args };
  return { text, toolCalls: [call] };
}

/** 造一个"并行调用多个工具"的 AssistantTurn。 */
export function toolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>, text = ''): AssistantTurn {
  return {
    text,
    toolCalls: calls.map((c) => ({ id: nextCallId(), name: c.name, args: c.args })),
  };
}

/** 造一个"直接回答"的 AssistantTurn（没有工具调用 = final answer）。 */
export function finalAnswer(text: string): AssistantTurn {
  return { text, toolCalls: [] };
}
