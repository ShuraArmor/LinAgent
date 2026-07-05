import type { Tool } from '../types.ts';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '%' | '^' | 'u-' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  'u-': 3,
  '^': 4,
};
const RIGHT_ASSOC = new Set(['^', 'u-']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input.trim();
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i;
      while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
      const num = Number(s.slice(i, j));
      if (Number.isNaN(num)) throw new Error(`Invalid number（非法数字）: "${s.slice(i, j)}"`);
      tokens.push({ kind: 'num', value: num });
      i = j;
      continue;
    }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '^') {
      const prev = tokens[tokens.length - 1];
      const isUnary = c === '-' && (!prev || prev.kind === 'op' || prev.kind === 'lparen');
      tokens.push({ kind: 'op', value: isUnary ? 'u-' : c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character（非法字符）"${c}"，位置 ${i}`);
  }
  return tokens;
}

function toRPN(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];
  for (const t of tokens) {
    if (t.kind === 'num') { output.push(t); continue; }
    if (t.kind === 'lparen') { stack.push(t); continue; }
    if (t.kind === 'rparen') {
      while (stack.length && stack[stack.length - 1].kind !== 'lparen') {
        output.push(stack.pop()!);
      }
      if (!stack.length) throw new Error('Mismatched parentheses（括号不匹配）');
      stack.pop();
      continue;
    }
    // 操作符
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.kind !== 'op') break;
      const pTop = PRECEDENCE[top.value];
      const pCur = PRECEDENCE[t.value];
      if (pTop > pCur || (pTop === pCur && !RIGHT_ASSOC.has(t.value))) {
        output.push(stack.pop()!);
      } else break;
    }
    stack.push(t);
  }
  while (stack.length) {
    const top = stack.pop()!;
    if (top.kind === 'lparen' || top.kind === 'rparen') throw new Error('Mismatched parentheses（括号不匹配）');
    output.push(top);
  }
  return output;
}

function evalRPN(rpn: Token[]): number {
  const stack: number[] = [];
  for (const t of rpn) {
    if (t.kind === 'num') { stack.push(t.value); continue; }
    if (t.kind !== 'op') throw new Error('非法的 RPN token');
    if (t.value === 'u-') {
      const a = stack.pop();
      if (a === undefined) throw new Error('一元负号缺少操作数');
      stack.push(-a);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) throw new Error('缺少操作数');
    switch (t.value) {
      case '+': stack.push(a + b); break;
      case '-': stack.push(a - b); break;
      case '*': stack.push(a * b); break;
      case '/':
        if (b === 0) throw new Error('Division by zero（除零）');
        stack.push(a / b);
        break;
      case '%':
        if (b === 0) throw new Error('Modulo by zero（对零取模）');
        stack.push(a % b);
        break;
      case '^': stack.push(Math.pow(a, b)); break;
    }
  }
  if (stack.length !== 1) throw new Error('表达式不完整');
  return stack[0];
}

export function evaluateExpression(expr: string): number {
  return evalRPN(toRPN(tokenize(expr)));
}

export const calculatorTool: Tool = {
  name: 'calculator',
  description:
    '计算算术表达式。支持 + - * / % ^ 与括号，返回数值结果。',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '算术表达式，例如 "(3+4)*2^3"。',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  handler(args) {
    const expression = args.expression as string;
    const value = evaluateExpression(expression);
    return { expression, result: value };
  },
};
