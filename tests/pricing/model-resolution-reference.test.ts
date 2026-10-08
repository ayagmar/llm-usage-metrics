import { beforeAll, describe, expect, it } from 'vitest';

import { LiteLLMPricingFetcher } from '../../src/pricing/litellm-pricing-fetcher.js';

// Real model names as harnesses report them, resolved against the bundled snapshot and
// retired pricing. Any change here alters which price a user's events receive: when the
// matcher, model map, or snapshot changes on purpose, review each moved row and update it
// deliberately. `null` means the model must stay visibly unpriced rather than mispriced.
const REFERENCE_RESOLUTIONS: ReadonlyArray<[model: string, pricingKey: string | null]> = [
  // Anthropic: direct, dated, retired, Vertex, Bedrock, OpenRouter, effort suffixes.
  ['claude-opus-5-5', 'claude-opus-5-5'],
  ['claude-fable-5-1', 'claude-fable-5-1'],
  ['claude-opus-4-8', 'claude-opus-4-8'],
  ['claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6'],
  ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5-20250929'],
  ['claude-sonnet-4-20250514', 'claude-sonnet-4-20250514'],
  ['claude-3-7-sonnet-20250219', 'claude-3-7-sonnet-20250219'],
  ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
  ['claude-sonnet-4-5@20250929', 'vertex_ai/claude-sonnet-4-5@20250929'],
  ['gpt-5.4-high', 'gpt-5.4'],
  ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-5-20250929-v1:0'],
  ['anthropic/claude-sonnet-4.5', 'openrouter/anthropic/claude-sonnet-4.5'],
  ['claude-opus-5-5-medium', 'claude-opus-5-5'],
  ['claude-sonnet-4-5-thinking', 'claude-sonnet-4-5'],
  // OpenAI: variants must not borrow their parent's price.
  ['gpt-5.5', 'gpt-5.5'],
  ['gpt-5.4', 'gpt-5.4'],
  ['gpt-5.4-mini', 'gpt-5.4-mini'],
  ['gpt-5.3-codex', 'gpt-5.3-codex'],
  ['gpt-5.3-codex-spark', 'gpt-5.3-codex'],
  ['gpt-5.3-codex-high', 'gpt-5.3-codex'],
  ['gpt-5.4-xhigh', 'gpt-5.4'],
  ['gpt-5-codex', 'gpt-5-codex'],
  ['gpt-5-codex-mini', null],
  ['gpt-6-astra', 'gpt-6-astra'],
  ['gpt-4.1', 'gpt-4.1'],
  ['o3', 'o3'],
  ['openai/gpt-5.4', 'gpt-5.4'],
  // Google, including Antigravity's labels.
  ['gemini-2.5-pro', 'gemini-2.5-pro'],
  ['gemini-2.5-flash', 'gemini-2.5-flash'],
  ['gemini-3-flash-preview', 'gemini-3-flash-preview'],
  ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview'],
  ['gemini-3-pro-a', 'vertex_ai/gemini-3-pro-preview'],
  ['gemini-3-flash-a', 'gemini/gemini-3-flash-preview'],
  ['antigravity-gemini-3-pro-high', 'vertex_ai/gemini-3-pro-preview'],
  ['gemini-pro-default', null],
  // Other providers: first-party keys win over resellers.
  ['k2p5', 'moonshot/kimi-k2.5'],
  ['kimi-k2.6', 'moonshot/kimi-k2.6'],
  ['kimi-for-coding', null],
  ['kimi-k2-thinking', 'moonshot/kimi-k2-thinking'],
  ['deepseek-v3.2', 'deepseek/deepseek-v3.2'],
  ['deepseek/deepseek-v4.1-flash', 'openrouter/deepseek/deepseek-v4.1-flash'],
  ['deepseek-flash', 'deepseek-flash'],
  ['qwen3-max', 'openrouter/qwen/qwen3-max'],
  ['qwen3-coder-plus', 'openrouter/qwen/qwen3-coder-plus'],
  ['glm-4.7', 'zai/glm-4.7'],
  ['minimax-m2.5', 'openrouter/minimax/minimax-m2.5'],
  ['grok-4', 'xai/grok-4'],
];

describe('model resolution reference', () => {
  const fetcher = new LiteLLMPricingFetcher({
    offline: true,
    cacheFilePath: '/nonexistent/llm-usage-metrics-reference-cache.json',
  });

  beforeAll(async () => {
    await fetcher.load();
  });

  it.each(REFERENCE_RESOLUTIONS)('resolves %s to %s', (model, pricingKey) => {
    const resolvedKey = fetcher.getPricing(model) ? fetcher.resolveModelAlias(model) : null;

    expect(resolvedKey).toBe(pricingKey);
  });
});
