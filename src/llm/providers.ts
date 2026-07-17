/**
 * Provider preset 表：用户只需选一个 `provider` 名字，baseUrl / 协议 / 默认模型
 * 会自动带上。若要覆盖，可通过 env 变量 LLM_MODEL / LLM_BASE_URL。
 */

export type Protocol = 'openai' | 'anthropic';

export interface ProviderPreset {
  /** 走哪种协议。 */
  protocol: Protocol;
  /** 默认 base URL；可通过 LLM_BASE_URL 覆盖。 */
  baseUrl: string;
  /** 默认模型；可通过 LLM_MODEL 覆盖。 */
  defaultModel: string;
  /** 该 provider 常用的环境变量名，作为 LLM_API_KEY 之外的兜底。 */
  apiKeyEnv?: string;
  /** 简短说明；报错和 --help 里会显示。 */
  description?: string;
  /**
   * 是否支持 response_format:{type:"json_schema"}。
   * 只有官方 OpenAI 稳定支持；DeepSeek/Moonshot/智谱/Groq 等只支持 json_object
   * （对 json_schema 直接 400）。不支持时 complete() 降级到 json_object + prompt 描述。
   * 默认 false（保守）。
   */
  supportsJsonSchema?: boolean;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  openai: {
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    description: 'OpenAI 官方 API',
    supportsJsonSchema: true,
  },
  anthropic: {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    description: 'Anthropic Claude',
  },
  deepseek: {
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek（OpenAI 兼容协议）',
  },
  moonshot: {
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    description: 'Moonshot Kimi（OpenAI 兼容协议）',
  },
  dashscope: {
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    description: '阿里 DashScope / 千问（OpenAI 兼容协议）',
  },
  zhipu: {
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
    description: '智谱 GLM（OpenAI 兼容协议）',
  },
  openrouter: {
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    description: 'OpenRouter 聚合器',
  },
  groq: {
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    apiKeyEnv: 'GROQ_API_KEY',
    description: 'Groq（OpenAI 兼容协议）',
  },
  ollama: {
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    description: '本地 Ollama（OpenAI 兼容端点）',
  },
};

export function listProviders(): string {
  return Object.entries(PROVIDERS)
    .map(([name, p]) => `  ${name.padEnd(11)} ${p.description ?? ''} — 默认模型: ${p.defaultModel}`)
    .join('\n');
}
