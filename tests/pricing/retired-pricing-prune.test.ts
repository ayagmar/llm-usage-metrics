import { describe, expect, it } from 'vitest';

import { pruneRetiredPricing } from '../../scripts/lib/prune-retired-pricing.mjs';
import {
  normalizeKey,
  resolveCanonicalModelKey,
} from '../../src/pricing/litellm-model-matching.js';
import snapshotPayload from '../../src/pricing/litellm-pricing-snapshot.json' with { type: 'json' };
import retiredPricingPayload from '../../src/pricing/litellm-retired-pricing.json' with { type: 'json' };
import type { ModelPricing } from '../../src/pricing/types.js';

function toPricingMap(pricingByModel: Record<string, ModelPricing>): Map<string, ModelPricing> {
  return new Map(
    Object.entries(pricingByModel).map(([model, pricing]) => [normalizeKey(model), pricing]),
  );
}

describe('pruneRetiredPricing', () => {
  it('drops a retired key only when every name it prices keeps its rates', () => {
    const live = toPricingMap({
      'zz/foo-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      'vv/aa/foo-model': { inputPer1MUsd: 5, outputPer1MUsd: 10 },
    });
    const retired = toPricingMap({
      // No live key prices it.
      'old/bar-model': { inputPer1MUsd: 3, outputPer1MUsd: 4 },
      // Its name resolves to zz/foo-model at the same rates, but it wins `aa/foo-model`
      // over vv/aa/foo-model, whose rates are higher.
      'or/aa/foo-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      // Every name it prices resolves to zz/foo-model at the same rates.
      'xx/foo-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    });

    expect([...pruneRetiredPricing(live, retired, resolveCanonicalModelKey).keys()]).toEqual([
      'old/bar-model',
      'or/aa/foo-model',
    ]);
  });

  it('leaves nothing to prune in the committed retired pricing', () => {
    const retired = toPricingMap(
      retiredPricingPayload.pricingByModel as Record<string, ModelPricing>,
    );
    const pruned = pruneRetiredPricing(
      toPricingMap(snapshotPayload.pricingByModel as Record<string, ModelPricing>),
      retired,
      resolveCanonicalModelKey,
    );

    expect([...pruned.keys()]).toEqual([...retired.keys()]);
  });
});
