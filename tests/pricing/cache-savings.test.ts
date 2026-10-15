import { describe, expect, it } from 'vitest';

import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import { estimateCacheSavingsUsd } from '../../src/pricing/cache-savings.js';
import { DEFAULT_PRICING_POLICY } from '../../src/pricing/cost-engine.js';
import type { ModelPricing, PricingSource } from '../../src/pricing/types.js';

function event(overrides: Partial<UsageEventInput> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'cache-savings-session',
    timestamp: '2026-02-01T10:00:00.000Z',
    model: 'gpt-4.1',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1_000_000,
    ...overrides,
  });
}

function pricingSource(pricingByModel: Record<string, ModelPricing>): PricingSource {
  return {
    resolveModelAlias: (model) => model,
    getPricing: (model) => pricingByModel[model],
  };
}

describe('estimateCacheSavingsUsd', () => {
  it('computes savings as cache-read tokens priced at the input/cache rate difference', () => {
    const source = pricingSource({
      'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8, cacheReadPer1MUsd: 0.5 },
    });

    // 1M cache-read tokens * ($2 - $0.50) per 1M = $1.50.
    expect(estimateCacheSavingsUsd([event()], source, DEFAULT_PRICING_POLICY)).toBe(1.5);
  });

  it('skips events whose model has no cache-read rate', () => {
    const source = pricingSource({
      'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 },
    });

    expect(estimateCacheSavingsUsd([event()], source, DEFAULT_PRICING_POLICY)).toBeUndefined();
  });

  it('returns undefined when no event has cache reads', () => {
    const source = pricingSource({
      'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8, cacheReadPer1MUsd: 0.5 },
    });

    expect(
      estimateCacheSavingsUsd([event({ cacheReadTokens: 0 })], source, DEFAULT_PRICING_POLICY),
    ).toBeUndefined();
  });

  it('clamps to zero when the cache rate exceeds the input rate', () => {
    const source = pricingSource({
      'gpt-4.1': { inputPer1MUsd: 1, outputPer1MUsd: 8, cacheReadPer1MUsd: 3 },
    });

    expect(estimateCacheSavingsUsd([event()], source, DEFAULT_PRICING_POLICY)).toBe(0);
  });

  it('uses long-context tier rates only for per-request sources', () => {
    const source = pricingSource({
      'gpt-4.1': {
        inputPer1MUsd: 2,
        outputPer1MUsd: 8,
        cacheReadPer1MUsd: 0.5,
        tiers: [{ aboveTokens: 272_000, inputPer1MUsd: 4, cacheReadPer1MUsd: 1 }],
      },
    });
    const longPrompt = event();

    // 1M cache-read tokens * ($4 - $1) per 1M at the tier; $1.50 at the base rates.
    expect(
      estimateCacheSavingsUsd([longPrompt], source, { perRequestSourceIds: new Set(['codex']) }),
    ).toBe(3);
    expect(estimateCacheSavingsUsd([longPrompt], source, DEFAULT_PRICING_POLICY)).toBe(1.5);
  });
});
