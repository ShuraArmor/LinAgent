/**
 * 解析 Plan 里 tool args 或 respond template 中的 `{{step_id.path.to.value}}` 引用。
 * 替换动作由 runtime 完成，而不是 LLM —— 这样 LLM 不必看到前置工具的原始输出
 * 就能引用其中的字段。
 */

const REF_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*)\s*\}\}/g;

export interface ResolveCtx {
  /** 前置步骤的输出，键为 step id，值为 { ok, result?, error? }。 */
  outputs: Record<string, { ok: boolean; result?: unknown; error?: string }>;
}

function walk(v: unknown, parts: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof p === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[p];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parsePath(raw: string): (string | number)[] {
  const parts: (string | number)[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    parts.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  return parts;
}

/**
 * 替换字符串中的引用。若引用嵌在一段更长的字符串里，非字符串叶节点会被
 * JSON 序列化后拼接；若整个字符串就是单个引用（如 `"{{s1.result}}"`），
 * 则原样返回值本身（保留类型）。
 */
function envelope(output: { ok: boolean; result?: unknown; error?: string }) {
  return { ok: output.ok, result: output.result, error: output.error };
}

function resolveString(str: string, ctx: ResolveCtx): unknown {
  const only = str.trim().match(/^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*)\s*\}\}$/);
  if (only) {
    const [, id, pathRaw] = only;
    const output = ctx.outputs[id];
    if (!output) throw new Error(`模板引用：未知的 step id "${id}"`);
    if (!output.ok) throw new Error(`模板引用：step "${id}" 执行失败，无法读取其 result`);
    const value = walk(envelope(output), parsePath(pathRaw));
    return value;
  }
  return str.replace(REF_RE, (_, id, pathRaw) => {
    const output = ctx.outputs[id];
    if (!output) throw new Error(`模板引用：未知的 step id "${id}"`);
    if (!output.ok) throw new Error(`模板引用：step "${id}" 执行失败，无法读取其 result`);
    const value = walk(envelope(output), parsePath(pathRaw));
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

/** 递归解析任意 JSON 值中的引用（典型是 args 对象）。 */
export function resolveValue(v: unknown, ctx: ResolveCtx): unknown {
  if (typeof v === 'string') return resolveString(v, ctx);
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, ctx));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveValue(val, ctx);
    return out;
  }
  return v;
}

/** 收集一个值里出现过的所有 `step_id` 引用；verifier 用它做 DAG 相关的检查。 */
export function collectRefs(v: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') {
    let m: RegExpExecArray | null;
    const re = new RegExp(REF_RE);
    while ((m = re.exec(v)) !== null) into.add(m[1]);
    return into;
  }
  if (Array.isArray(v)) { v.forEach((x) => collectRefs(x, into)); return into; }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v)) collectRefs(val, into);
  }
  return into;
}
