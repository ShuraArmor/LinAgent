import type { Tool } from '../types.ts';

// 确定性 mock 检索库 —— 满足题目"search 可 mock"的要求，
// 同时让测试保持离线、可复现。
const CORPUS: Array<{ title: string; url: string; snippet: string; keywords: string[] }> = [
  {
    title: 'TypeScript Handbook',
    url: 'https://www.typescriptlang.org/docs/handbook/intro.html',
    snippet: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
    keywords: ['typescript', 'ts', 'types', 'handbook'],
  },
  {
    title: 'Node.js Documentation',
    url: 'https://nodejs.org/docs',
    snippet: 'Node.js is a JavaScript runtime built on Chrome V8. Use the node:test module for tests.',
    keywords: ['node', 'nodejs', 'runtime', 'test'],
  },
  {
    title: 'Agent design patterns',
    url: 'https://example.com/agent-patterns',
    snippet:
      'A tool-using agent runs a loop: perceive, decide, act. Registration lets the LLM discover tools.',
    keywords: ['agent', 'tool', 'loop', 'llm'],
  },
  {
    title: 'Weather in Beijing',
    url: 'https://example.com/weather/beijing',
    snippet: 'Beijing typical July weather: hot and humid, 26–34°C, chance of thunderstorms.',
    keywords: ['weather', 'beijing', 'china', '北京', '天气'],
  },
  {
    title: 'Weather in Shanghai',
    url: 'https://example.com/weather/shanghai',
    snippet: 'Shanghai July: hot and rainy, 27–34°C, high humidity.',
    keywords: ['weather', 'shanghai', 'china', '上海', '天气'],
  },
  {
    title: 'Weather in Xi\'an',
    url: 'https://example.com/weather/xian',
    snippet: 'Xi\'an July: hot and dry, 22–33°C, low humidity, mostly sunny.',
    keywords: ['weather', 'xian', 'xi\'an', 'china', '西安', '天气'],
  },
  {
    title: 'Weather in Chengdu',
    url: 'https://example.com/weather/chengdu',
    snippet: 'Chengdu July: overcast and humid, 22–28°C, frequent light rain.',
    keywords: ['weather', 'chengdu', 'china', '成都', '天气'],
  },
  {
    title: 'Weather in Guangzhou',
    url: 'https://example.com/weather/guangzhou',
    snippet: 'Guangzhou July: hot and stormy, 27–34°C, very humid, thunderstorms.',
    keywords: ['weather', 'guangzhou', 'china', '广州', '天气'],
  },
  {
    title: 'Weather in Hangzhou',
    url: 'https://example.com/weather/hangzhou',
    snippet: 'Hangzhou July: warm and cloudy, 25–32°C, occasional showers.',
    keywords: ['weather', 'hangzhou', 'china', '杭州', '天气'],
  },
];

export const searchTool: Tool = {
  name: 'search',
  description:
    '在一个 mock 知识库中做关键词检索，最多返回 top_k 条 {title, url, snippet}。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '自由文本查询。' },
      top_k: { type: 'integer', description: '返回结果数上限（1-5），默认 3。' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler(args) {
    const query = String(args.query).toLowerCase().trim();
    const topK = Math.min(5, Math.max(1, (args.top_k as number | undefined) ?? 3));
    if (!query) return { query, results: [] };

    const terms = query.split(/\s+/).filter(Boolean);
    const scored = CORPUS.map((doc) => {
      const hay = `${doc.title} ${doc.snippet} ${doc.keywords.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (hay.includes(term)) score += 1;
        if (doc.keywords.some((k) => k.toLowerCase() === term)) score += 2;
      }
      return { doc, score };
    })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => ({ title: r.doc.title, url: r.doc.url, snippet: r.doc.snippet }));

    return { query, results: scored };
  },
};
