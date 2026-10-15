import { describe, expect, it } from 'vitest';

import { pruneRetiredPricing } from '../../scripts/lib/prune-retired-pricing.mjs';
import {
  normalizeKey,
  resolveCanonicalModelKey,
} from '../../src/pricing/litellm-model-matching.js';
import type { ModelPricing } from '../../src/pricing/types.js';

function toPricingMap(pricingByModel: Record<string, ModelPricing>): Map<string, ModelPricing> {
  return new Map(
    Object.entries(pricingByModel).map(([model, pricing]) => [normalizeKey(model), pricing]),
  );
}

describe('pruneRetiredPricing', () => {
  it('drops a retired key only when every name it prices keeps its rates', () => {
    const live = toPricingMap({
      'foo-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      'zz/baz-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      'vv/aa/baz-model': { inputPer1MUsd: 5, outputPer1MUsd: 10 },
      'gw/cohere/command-r': { inputPer1MUsd: 0.15, outputPer1MUsd: 0.6 },
    });
    const retired = toPricingMap({
      // Its name resolves to gw/cohere/command-r at the same rates, but only the key
      // itself is a prefix of `command-r-latest` or `command-r-2024-08-30`.
      'command-r': { inputPer1MUsd: 0.15, outputPer1MUsd: 0.6 },
      // No live key prices it.
      'old/bar-model': { inputPer1MUsd: 3, outputPer1MUsd: 4 },
      // Its name resolves to zz/baz-model at the same rates, but it wins `aa/baz-model`
      // over vv/aa/baz-model, whose rates are higher.
      'or/aa/baz-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      // Every name it prices, with or without a release suffix, resolves to foo-model at
      // the same rates.
      'xx/foo-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    });

    expect([...pruneRetiredPricing(live, retired, resolveCanonicalModelKey).keys()]).toEqual([
      'command-r',
      'old/bar-model',
      'or/aa/baz-model',
    ]);
  });
});
