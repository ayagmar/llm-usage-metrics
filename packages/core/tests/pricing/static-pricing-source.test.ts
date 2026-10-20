import { describe, expect, it } from 'vitest';

import {
  createDefaultOpenAiPricingSource,
  StaticPricingSource,
} from '../helpers/static-pricing-source.js';

describe('StaticPricingSource', () => {
  it('resolves aliases case-insensitively', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
      modelAliases: {
        'GPT-5.3-CODEX': 'gpt-5-codex',
      },
    });

    expect(source.resolveModelAlias('gpt-5.3-codex')).toBe('gpt-5-codex');
    expect(source.getPricing('gpt-5.3-codex')).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 2 });
  });

  it('resolves multi-hop aliases to the priced model', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
      modelAliases: {
        'custom-codex': 'intermediate-codex',
        'intermediate-codex': 'gpt-5-codex',
      },
    });

    expect(source.resolveModelAlias('custom-codex')).toBe('gpt-5-codex');
    expect(source.getPricing('custom-codex')).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 2 });
  });

  it('returns undefined for unknown models', () => {
    const source = createDefaultOpenAiPricingSource();

    expect(source.getPricing('unknown-model')).toBeUndefined();
  });
});
