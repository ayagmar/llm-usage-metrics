import type { UsageEvent } from '../domain/usage-event.js';
import { resolveRatesForEvent, type PricingPolicy } from './cost-engine.js';
import type { PricingSource } from './types.js';

const ONE_MILLION = 1_000_000;

/** Counterfactual: what cache-read tokens would have cost at the full
 *  input rate, minus what they cost at the cache-read rate. Estimated —
 *  only events whose model has both rates contribute. Per-request sources
 *  use the event's long-context tier rates, as pricing does. */
export function estimateCacheSavingsUsd(
  events: readonly UsageEvent[],
  pricingSource: PricingSource,
  policy: Pick<PricingPolicy, 'perRequestSourceIds'>,
): number | undefined {
  let savings: number | undefined;

  for (const event of events) {
    if (!event.model || event.cacheReadTokens <= 0) {
      continue;
    }

    const pricing = pricingSource.getPricing(pricingSource.resolveModelAlias(event.model));

    if (!pricing) {
      continue;
    }

    const rates = resolveRatesForEvent(
      event,
      pricing,
      policy.perRequestSourceIds.has(event.source),
    );

    if (rates.cacheReadPer1MUsd === undefined) {
      continue;
    }

    const perEvent =
      (event.cacheReadTokens / ONE_MILLION) * (rates.inputPer1MUsd - rates.cacheReadPer1MUsd);
    savings = (savings ?? 0) + Math.max(0, perEvent);
  }

  return savings;
}
