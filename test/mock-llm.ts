import type { LLMChatOpts, LLMClient, Message } from '../src/types.ts';

export type MockReply = string | ((messages: Message[], turn: number) => string);

/**
 * A scripted LLM. On each `chat` call it returns the next reply in the queue.
 * When `onDelta` is passed, the reply is emitted in ~8-char chunks to simulate streaming.
 */
export class MockLLM implements LLMClient {
  readonly name = 'mock';
  public calls: Array<Message[]> = [];
  private queue: MockReply[] = [];

  constructor(initial?: MockReply[]) {
    if (initial) this.queue.push(...initial);
  }

  enqueue(reply: MockReply): void {
    this.queue.push(reply);
  }

  enqueueMany(replies: MockReply[]): void {
    this.queue.push(...replies);
  }

  async chat(messages: Message[], opts?: LLMChatOpts): Promise<string> {
    this.calls.push(messages);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('MockLLM: queue is empty');
    const reply = typeof next === 'function' ? next(messages, this.calls.length) : next;
    if (opts?.onDelta) {
      for (let i = 0; i < reply.length; i += 8) {
        opts.onDelta(reply.slice(i, i + 8));
      }
    }
    return reply;
  }
}

export function toolCall(name: string, args: Record<string, unknown>, thought = ''): string {
  return JSON.stringify({ thought, action: 'tool_call', tool_name: name, tool_args: args });
}

export function finalAnswer(text: string, thought = ''): string {
  return JSON.stringify({ thought, action: 'final_answer', final_answer: text });
}
