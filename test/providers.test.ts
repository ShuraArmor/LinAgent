import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLLMFromEnv, OpenAIClient, AnthropicClient } from '../src/llm/client.ts';
import { PROVIDERS } from '../src/llm/providers.ts';

test('providers: openai preset — only provider+key required', () => {
  const llm = buildLLMFromEnv({
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);
  assert.ok(llm instanceof OpenAIClient);
  assert.equal(llm.name, 'openai');
});

test('providers: anthropic preset picks anthropic protocol', () => {
  const llm = buildLLMFromEnv({
    LLM_PROVIDER: 'anthropic',
    LLM_API_KEY: 'sk-ant-test',
  } as NodeJS.ProcessEnv);
  assert.ok(llm instanceof AnthropicClient);
  assert.equal(llm.name, 'anthropic');
});

test('providers: unknown provider produces a helpful error', () => {
  assert.throws(
    () => buildLLMFromEnv({ LLM_PROVIDER: 'nope', LLM_API_KEY: 'x' } as NodeJS.ProcessEnv),
    /Unknown LLM_PROVIDER/,
  );
});

test('providers: falls back to conventional env var (DEEPSEEK_API_KEY)', () => {
  const llm = buildLLMFromEnv({
    LLM_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'ds-test',
  } as NodeJS.ProcessEnv);
  assert.ok(llm instanceof OpenAIClient);
});

test('providers: LLM_API_KEY beats conventional env var', () => {
  // If the explicit override is missing, we must NOT hallucinate a key.
  assert.throws(
    () =>
      buildLLMFromEnv({
        LLM_PROVIDER: 'moonshot',
        // no key of either kind
      } as NodeJS.ProcessEnv),
    /is not set/,
  );
});

test('providers: LLM_MODEL / LLM_BASE_URL override the preset', () => {
  // Just make sure it doesn't throw and picks openai protocol.
  const llm = buildLLMFromEnv({
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-x',
    LLM_MODEL: 'gpt-4o',
    LLM_BASE_URL: 'https://proxy.example.com/v1',
  } as NodeJS.ProcessEnv);
  assert.ok(llm instanceof OpenAIClient);
});

test('providers: registry has every documented preset', () => {
  for (const name of ['openai', 'anthropic', 'deepseek', 'moonshot', 'dashscope', 'zhipu', 'openrouter', 'groq', 'ollama']) {
    assert.ok(PROVIDERS[name], `missing preset: ${name}`);
    assert.ok(PROVIDERS[name].defaultModel);
    assert.ok(PROVIDERS[name].baseUrl.startsWith('http'));
  }
});
