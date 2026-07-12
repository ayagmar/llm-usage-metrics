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

  it('matches provider-prefixed pricing keys', () => {
    const pricingByModel = createPricingMap(['openai/gpt-4.1']);

    expect(resolveCanonicalModelKey(normalizeKey('gpt-4.1'), pricingByModel)).toBe(
      'openai/gpt-4.1',
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
