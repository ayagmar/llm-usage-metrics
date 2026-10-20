import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  namesReachingPricing,
  pruneRetiredPricing,
  pricingProbeNames,
} from '../../scripts/lib/prune-retired-pricing.mjs';
import { normalizeKey, resolveCanonicalModelKey } from '@ayagmar/agent-sessions/pricing';
import snapshotPayload from '../../packages/core/src/pricing/litellm-pricing-snapshot.json' with { type: 'json' };
import retiredPricingPayload from '../../packages/core/src/pricing/litellm-retired-pricing.json' with { type: 'json' };
import type { ModelPricing } from '@ayagmar/agent-sessions/pricing';
import prunedRetiredPricingPayload from '../fixtures/pricing/pruned-retired-pricing.json' with { type: 'json' };

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

  // The generator writes the entries it prunes to the fixture, so old = committed + pruned.
  it('prices every name the pruned retired entries priced as before', () => {
    const live = toPricingMap(snapshotPayload.pricingByModel as Record<string, ModelPricing>);
    const committed = toPricingMap(
      retiredPricingPayload.pricingByModel as Record<string, ModelPricing>,
    );
    const pruned = toPricingMap(
      prunedRetiredPricingPayload.pricingByModel as Record<string, ModelPricing>,
    );
    const old = new Map(
      [...committed, ...pruned].sort(([left], [right]) => (left < right ? -1 : 1)),
    );
    const withBackfill = (retired: ReadonlyMap<string, ModelPricing>) =>
      new Map([...live, ...[...retired].filter(([model]) => !live.has(model))]);
    const oldPricing = withBackfill(old);
    const newPricing = withBackfill(committed);
    const resolve = (name: string, pricingByModel: ReadonlyMap<string, ModelPricing>) =>
      pricingByModel.get(resolveCanonicalModelKey(name, pricingByModel) ?? name);

    expect(pruned.size).toBeGreaterThan(0);
    expect([...pruned.keys()].filter((model) => committed.has(model) || live.has(model))).toEqual(
      [],
    );

    // A name no pruned entry can match on its own resolves the same with or without them,
    // so only the names that can reach one are compared.
    const names = namesReachingPricing(
      new Set([...live.keys(), ...old.keys()].flatMap(pricingProbeNames)),
      pruned,
      resolveCanonicalModelKey,
    );
    const moved = names.filter(
      (name) => !isDeepStrictEqual(resolve(name, newPricing), resolve(name, oldPricing)),
    );

    expect(names.length).toBeGreaterThan(0);
    expect(moved).toEqual([]);
  }, 30_000);
});
