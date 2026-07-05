/**
 * 一个小巧、安全的表达式 DSL，专用于 Plan 中的后置断言。
 *
 * 文法（不执行任何代码，不使用 `eval`）：
 *   expr    := or
 *   or      := and ("||" and)*
 *   and     := not ("&&" not)*
 *   not     := "!"? cmp
 *   cmp     := add (("==" | "!=" | "<=" | ">=" | "<" | ">") add)?
 *   add     := mul (("+" | "-") mul)*
 *   mul     := unary (("*" | "/") unary)*
 *   unary   := "-"? primary
 *   primary := number | string | bool | null | path | "len(" expr ")" | "(" expr ")"
 *   path    := ident ("." ident | "[" number "]")*
 *
 * 路径在求值时会在 `{ result, args, step_id }` 上下文里解析，例如
 * `result.ok`、`len(result.results) > 0`、`result.temperature.high < 40`。
 *
 * DSL 有意保持极简：除了 `len` 之外不允许任何函数调用；
 * 除了给定上下文外不允许任意属性访问；无任何副作用。
 */

export class ExpectError extends Error {}
export class ExpectParseError extends ExpectError {}
export class ExpectEvalError extends ExpectError {}

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'path'; parts: (string | number)[] }
  | { t: 'len'; arg: Node }
  | { t: 'unop'; op: '!' | '-'; a: Node }
  | { t: 'binop'; op: string; l: Node; r: Node };

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  private peek(n = 0): string { return this.s[this.i + n] ?? ''; }
  private skip(): void { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
  private eat(str: string): boolean {
    this.skip();
    if (this.s.startsWith(str, this.i)) { this.i += str.length; return true; }
    return false;
  }
  private need(str: string): void {
    if (!this.eat(str)) throw new ExpectParseError(`expected "${str}" at position ${this.i}`);
  }

  parse(): Node {
    const n = this.parseOr();
    this.skip();
    if (this.i !== this.s.length) throw new ExpectParseError(`unexpected trailing input at ${this.i}`);
    return n;
  }

  private parseOr(): Node {
    let l = this.parseAnd();
    while (this.eat('||')) l = { t: 'binop', op: '||', l, r: this.parseAnd() };
    return l;
  }
  private parseAnd(): Node {
    let l = this.parseNot();
    while (this.eat('&&')) l = { t: 'binop', op: '&&', l, r: this.parseNot() };
    return l;
  }
  private parseNot(): Node {
    this.skip();
    if (this.eat('!')) return { t: 'unop', op: '!', a: this.parseCmp() };
    return this.parseCmp();
  }
  private parseCmp(): Node {
    const l = this.parseAdd();
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (this.eat(op)) return { t: 'binop', op, l, r: this.parseAdd() };
    }
    return l;
  }
  private parseAdd(): Node {
    let l = this.parseMul();
    while (true) {
      this.skip();
      if (this.eat('+')) l = { t: 'binop', op: '+', l, r: this.parseMul() };
      else if (this.eat('-')) l = { t: 'binop', op: '-', l, r: this.parseMul() };
      else break;
    }
    return l;
  }
  private parseMul(): Node {
    let l = this.parseUnary();
    while (true) {
      this.skip();
      if (this.eat('*')) l = { t: 'binop', op: '*', l, r: this.parseUnary() };
      else if (this.eat('/')) l = { t: 'binop', op: '/', l, r: this.parseUnary() };
      else break;
    }
    return l;
  }
  private parseUnary(): Node {
    this.skip();
    if (this.eat('-')) return { t: 'unop', op: '-', a: this.parsePrimary() };
    return this.parsePrimary();
  }
  private parsePrimary(): Node {
    this.skip();
    // number
    if (/[0-9]/.test(this.peek()) || (this.peek() === '.' && /[0-9]/.test(this.peek(1)))) {
      let j = this.i;
      while (j < this.s.length && /[0-9.]/.test(this.s[j])) j++;
      const v = Number(this.s.slice(this.i, j));
      this.i = j;
      return { t: 'num', v };
    }
    // string
    if (this.peek() === '"' || this.peek() === "'") {
      const q = this.peek(); this.i++;
      let out = '';
      while (this.i < this.s.length && this.s[this.i] !== q) {
        if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) { out += this.s[this.i + 1]; this.i += 2; continue; }
        out += this.s[this.i++];
      }
      this.need(q);
      return { t: 'str', v: out };
    }
    if (this.eat('(')) {
      const inner = this.parseOr();
      this.need(')');
      return inner;
    }
    // identifier / keyword
    let j = this.i;
    while (j < this.s.length && /[A-Za-z_]/.test(this.s[j])) j++;
    if (j === this.i) throw new ExpectParseError(`unexpected char "${this.peek()}" at ${this.i}`);
    const ident = this.s.slice(this.i, j);
    this.i = j;
    if (ident === 'true') return { t: 'bool', v: true };
    if (ident === 'false') return { t: 'bool', v: false };
    if (ident === 'null') return { t: 'null' };
    if (ident === 'len' && this.eat('(')) {
      const arg = this.parseOr();
      this.need(')');
      return { t: 'len', arg };
    }
    // path: ident (. ident | [n])*
    const parts: (string | number)[] = [ident];
    while (true) {
      this.skip();
      if (this.eat('.')) {
        let k = this.i;
        while (k < this.s.length && /[A-Za-z0-9_]/.test(this.s[k])) k++;
        if (k === this.i) throw new ExpectParseError(`expected identifier after "." at ${this.i}`);
        parts.push(this.s.slice(this.i, k));
        this.i = k;
      } else if (this.eat('[')) {
        let k = this.i;
        while (k < this.s.length && /[0-9]/.test(this.s[k])) k++;
        if (k === this.i) throw new ExpectParseError(`expected number in "[]" at ${this.i}`);
        parts.push(Number(this.s.slice(this.i, k)));
        this.i = k;
        this.need(']');
      } else break;
    }
    return { t: 'path', parts };
  }
}

function resolvePath(ctx: Record<string, unknown>, parts: (string | number)[]): unknown {
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof p === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[p];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
  }
  return cur;
}

function evalNode(n: Node, ctx: Record<string, unknown>): unknown {
  switch (n.t) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'bool': return n.v;
    case 'null': return null;
    case 'path': return resolvePath(ctx, n.parts);
    case 'len': {
      const v = evalNode(n.arg, ctx);
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') return Object.keys(v).length;
      return 0;
    }
    case 'unop': {
      const a = evalNode(n.a, ctx);
      if (n.op === '!') return !a;
      if (n.op === '-') return -Number(a);
      throw new ExpectEvalError(`unknown unary op ${n.op}`);
    }
    case 'binop': {
      // 短路布尔运算
      if (n.op === '&&') return Boolean(evalNode(n.l, ctx)) && Boolean(evalNode(n.r, ctx));
      if (n.op === '||') return Boolean(evalNode(n.l, ctx)) || Boolean(evalNode(n.r, ctx));
      const l = evalNode(n.l, ctx);
      const r = evalNode(n.r, ctx);
      switch (n.op) {
        case '==': return l === r;
        case '!=': return l !== r;
        case '<':  return (l as number) < (r as number);
        case '<=': return (l as number) <= (r as number);
        case '>':  return (l as number) > (r as number);
        case '>=': return (l as number) >= (r as number);
        case '+':  return (l as number) + (r as number);
        case '-':  return (l as number) - (r as number);
        case '*':  return (l as number) * (r as number);
        case '/':  return (l as number) / (r as number);
      }
      throw new ExpectEvalError(`unknown binop ${n.op}`);
    }
  }
}

export function evalExpect(expr: string, ctx: Record<string, unknown>): boolean {
  const ast = new Parser(expr).parse();
  return Boolean(evalNode(ast, ctx));
}

/** 仅做静态解析以校验表达式语法（verifier 用它做静态检查）。 */
export function parseExpect(expr: string): void {
  new Parser(expr).parse();
}
