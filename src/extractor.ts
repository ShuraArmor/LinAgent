import type { LLMClient, Message } from './types.ts';
import type { FactCandidate, MemoryLayer } from './memory.ts';

/**
 * 抽取契约：拿到一轮完整对话的尾部，交给 LLM 抽出关于"用户本人"的持久事实，
 * 以严格 JSON 数组形式返回。
 *
 * 有意保持范围窄：
 *   - 只抽关于用户的事实（identity / preferences / facts / ongoing）。
 *   - 显式标注矛盾（contradicts），让合并层能正确 supersede。
 *   - 输出坏了 → 整段丢弃，绝不做半吊子写入。fail-safe 优先，绝不 fail-loud。
 */

const SYSTEM = `你是一个记忆抽取器。基于最新一轮的用户输入（以及助手的回复），
识别出关于"用户本人"的、值得在未来会话中记住的持久事实。

只输出一个 JSON 对象，前后不加任何文字，不加代码围栏：

{
  "facts": [
    { "layer": "identity" | "preferences" | "facts" | "ongoing",
      "text": "<简短、自包含的陈述，跟用户使用的语言一致>",
      "confidence": <0.5..1.0>,
      "contradicts": "<可选：本条替代的旧认知，例如 '住在北京'>",
      "tags": ["<可选：短类别标签>"] }
  ]
}

各层含义：
- identity     ：稳定、单值（常住城市、母语、职业）
- preferences  ：用户希望被如何对待（"回复用中文"、"不要客套话"）
- facts        ：其它值得知道的事（"喜欢喝美式"、"开特斯拉"）
- ongoing      ：有时间范围的（"本周在读 SICP"、"Q3 项目：MLops"）

规则：
- 如果本轮只是闲聊、没有可持久化的内容，直接返回 {"facts": []}。
- 不要凭空编造 —— 用户没明确说的，一律不要抽出。
- 不要抽任何秘密/密码/密钥。
- text 必须自包含（不要出现"如前所述"/"上面提到的"）。
- 如果用户"更正"了旧信息（搬家、换工作），在 "contradicts" 里写清楚被替代的旧认知。
- 宁精不多 —— 两条清晰的事实胜过六条模糊的。`;

export interface ExtractResult {
  candidates: FactCandidate[];
  raw: string;
}

/**
 * 从 transcript 中抽取事实。`transcript` 应该是"最近一轮用户输入 + 助手回复"
 * 的简短渲染 —— 具体粒度由调用方决定。
 */
export async function extractFacts(
  llm: LLMClient,
  transcript: string,
): Promise<ExtractResult> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: transcript },
  ];
  let raw = '';
  try {
    raw = await llm.chat(messages, { temperature: 0 });
  } catch {
    return { candidates: [], raw: '' };
  }
  return { candidates: parseCandidates(raw), raw };
}

/** 单独导出以便测试；抽取器内部走的就是这份 parser。 */
export function parseCandidates(raw: string): FactCandidate[] {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return [];
  let obj: unknown;
  try { obj = JSON.parse(jsonText); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];
  const facts = (obj as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  const out: FactCandidate[] = [];
  const LAYERS: MemoryLayer[] = ['identity', 'preferences', 'facts', 'ongoing'];
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    const layer = (f as { layer?: unknown }).layer;
    const text = (f as { text?: unknown }).text;
    if (typeof layer !== 'string' || !LAYERS.includes(layer as MemoryLayer)) continue;
    if (typeof text !== 'string' || !text.trim()) continue;
    const conf = (f as { confidence?: unknown }).confidence;
    const contradicts = (f as { contradicts?: unknown }).contradicts;
    const tags = (f as { tags?: unknown }).tags;
    out.push({
      layer: layer as MemoryLayer,
      text: text.trim(),
      confidence: typeof conf === 'number' && conf >= 0 && conf <= 1 ? conf : 0.8,
      contradicts: typeof contradicts === 'string' && contradicts.trim() ? contradicts.trim() : undefined,
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string').slice(0, 6) : undefined,
    });
  }
  return out;
}

function extractJsonObject(raw: string): string | null {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
