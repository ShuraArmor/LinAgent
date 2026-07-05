import type { AgentDecision } from '../types.ts';

export class ParseError extends Error {}

/** 剥掉 ```json ... ``` 围栏，然后定位第一个平衡花括号的 JSON 对象。 */
function extractJson(raw: string): string {
  let s = raw.trim();

  // 剥掉围栏：```json\n{...}\n``` 或 ```\n{...}\n```
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start < 0) throw new ParseError('LLM 输出中没有找到 JSON 对象');

  // 花括号配平扫描，忽略字符串内的 { }。
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new ParseError('LLM 输出中的 JSON 对象花括号不平衡');
}

export function parseAgentOutput(raw: string): AgentDecision {
  const jsonText = extractJson(raw);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(
      `非法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const thought = typeof obj.thought === 'string' ? obj.thought : undefined;
  const action = obj.action;

  if (action === 'tool_call') {
    const name = obj.tool_name;
    const args = obj.tool_args;
    if (typeof name !== 'string' || !name.trim()) {
      throw new ParseError('tool_call 缺少字符串字段 "tool_name"');
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new ParseError('tool_call 缺少对象字段 "tool_args"');
    }
    return {
      thought,
      action: 'tool_call',
      tool: { name, args: args as Record<string, unknown> },
    };
  }

  if (action === 'final_answer') {
    const final = obj.final_answer;
    if (typeof final !== 'string') {
      throw new ParseError('final_answer 缺少字符串字段 "final_answer"');
    }
    return { thought, action: 'final_answer', final };
  }

  throw new ParseError(`非法的 "action" 字段: ${JSON.stringify(action)}`);
}
