import {
  createUsageEvent,
  type CostMode,
  type UsageEventInput,
} from '../../src/domain/usage-event.js';
import { resolveCostMode } from '../../src/pricing/cost-engine.js';
import type { PricedUsageEvent } from '../../src/pricing/types.js';

export type PricedUsageEventInput = UsageEventInput & { costMode?: CostMode };

/**
 * A usage event as the pricing engine receives it: a logged cost is explicit by default, by
 * the rule the CLI's `createUsageEvent` applies too.
 */
export function createPricedUsageEvent(input: PricedUsageEventInput): PricedUsageEvent {
  const event = createUsageEvent(input);

  return { ...event, costMode: resolveCostMode(input.costMode, event.costUsd) };
}
