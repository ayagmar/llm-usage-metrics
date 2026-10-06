import { describe, expect, it } from 'vitest';

import {
  normalizeKey,
  resolveCanonicalModelKey,
} from '../../src/pricing/litellm-model-matching.js';
import type { ModelPricing } from '../../src/pricing/types.js';

const pricing: ModelPricing = {
  inputPer1MUsd: 1,
  outputPer1MUsd: 2,
};

function createPricingMap(modelNames: string[]): Map<string, ModelPricing> {
  return new Map(modelNames.map((modelName) => [modelName, pricing]));
}

describe('litellm model matching', () => {
  it('normalizes pricing keys by trimming and lowercasing', () => {
    expect(normalizeKey('  OpenAI/GPT-4.1  ')).toBe('openai/gpt-4.1');
  });

  it('returns exact matches', () => {
    const pricingByModel = createPricingMap(['gpt-4.1']);

    expect(resolveCanonicalModelKey(normalizeKey('gpt-4.1'), pricingByModel)).toBe('gpt-4.1');
  });

  it('returns preferred pricing keys from the alias map', () => {
    const pricingByModel = createPricingMap(['gemini/gemini-3-flash-preview']);

    expect(resolveCanonicalModelKey(normalizeKey('gemini-3-flash-a'), pricingByModel)).toBe(
      'gemini/gemini-3-flash-preview',
    );
  });

  it('leaves the DeepSeek v4.1 flash route unpriced instead of borrowing v4 rates', () => {
    const pricingByModel = createPricingMap(['deepseek-v4-flash', 'deepseek-v4-pro']);

    // deepseek-flash is DeepSeek-V41-Flash. Nothing publishes v4.1 rates, so a
    // fuzzy match onto deepseek-v4-flash would silently misprice the model.
    expect(
      resolveCanonicalModelKey(normalizeKey('deepseek-flash'), pricingByModel),
    ).toBeUndefined();
    // The guard also covers the model key the DSH catalog implies, since a
    // later catalog release could report it verbatim.
    expect(
      resolveCanonicalModelKey(normalizeKey('deepseek-v41-flash'), pricingByModel),
    ).toBeUndefined();
  });

  it('matches provider-prefixed pricing keys', () => {
    const pricingByModel = createPricingMap(['openai/gpt-4.1']);

    expect(resolveCanonicalModelKey(normalizeKey('gpt-4.1'), pricingByModel)).toBe(
      'openai/gpt-4.1',
    );
  });

  it('prefers the first-party provider over resellers for provider-prefixed keys', () => {
    const pricingByModel = createPricingMap([
      'azure_ai/deepseek-v3.2',
      'deepseek/deepseek-v3.2',
      'openrouter/deepseek/deepseek-v3.2',
      'sambanova/deepseek-v3.2',
    ]);

    expect(resolveCanonicalModelKey(normalizeKey('deepseek-v3.2'), pricingByModel)).toBe(
      'deepseek/deepseek-v3.2',
    );
  });

  it('prefers list-price clouds over resellers, then keys defining more rates', () => {
    const cloudOverReseller = createPricingMap([
      'deepinfra/anthropic/claude-x',
      'vertex_ai/claude-x',
    ]);
    const moreRates = new Map<string, ModelPricing>([
      ['novita/zai-org/glm-4.7', pricing],
      ['baseten/zai-org/glm-4.7', { ...pricing, cacheReadPer1MUsd: 0.1 }],
    ]);

    expect(resolveCanonicalModelKey(normalizeKey('claude-x'), cloudOverReseller)).toBe(
      'vertex_ai/claude-x',
    );
    expect(resolveCanonicalModelKey(normalizeKey('glm-4.7'), moreRates)).toBe(
      'baseten/zai-org/glm-4.7',
    );
  });

  it('bridges release suffixes but not variants or minor versions in prefix matches', () => {
    const pricingByModel = createPricingMap(['gpt-5-codex', 'claude-fable-5', 'claude-sonnet-4-5']);

    expect(
      resolveCanonicalModelKey(normalizeKey('claude-sonnet-4-5-20250929'), pricingByModel),
    ).toBe('claude-sonnet-4-5');
    expect(
      resolveCanonicalModelKey(normalizeKey('claude-sonnet-4-5@20250929'), pricingByModel),
    ).toBe('claude-sonnet-4-5');
    expect(resolveCanonicalModelKey(normalizeKey('gpt-5-codex-mini'), pricingByModel)).toBe(
      undefined,
    );
    expect(resolveCanonicalModelKey(normalizeKey('claude-fable-5-1'), pricingByModel)).toBe(
      undefined,
    );
  });

  it('matches fuzzy model names when numeric signatures are compatible', () => {
    const pricingByModel = createPricingMap(['gpt-5.2-codex']);

    expect(resolveCanonicalModelKey(normalizeKey('gpt52codex'), pricingByModel)).toBe(
      'gpt-5.2-codex',
    );
  });

  it('returns undefined when no match is close enough', () => {
    const pricingByModel = createPricingMap(['gpt-4.1']);

    expect(resolveCanonicalModelKey(normalizeKey('totally-unrelated'), pricingByModel)).toBe(
      undefined,
    );
  });

  it('resolves a 256-character junk model key to undefined quickly', () => {
    const pricingByModel = createPricingMap(['gpt-4.1', 'gpt-5.2-codex', 'gemini/gemini-3-flash']);

    expect(resolveCanonicalModelKey(normalizeKey('x'.repeat(256)), pricingByModel)).toBe(undefined);
  });

  it('skips fuzzy matching for guarded model names', () => {
    const pricingByModel = createPricingMap(['kimi-for-codng']);

    expect(resolveCanonicalModelKey(normalizeKey('kimi-for-coding'), pricingByModel)).toBe(
      undefined,
    );
  });
});
