import {
  createUsageEvent,
  type CostMode,
  type UsageEventInput,
} from '../../src/domain/usage-event.js';
import type { PricedUsageEvent } from '../../src/pricing/types.js';

export type PricedUsageEventInput = UsageEventInput & { costMode?: CostMode };

/**
 * A usage event as the pricing engine receives it: a logged cost is explicit by default.
 * Mirrors the CLI's `createUsageEvent` (src/domain/usage-event.ts); keep the two in step.
 */
export function createPricedUsageEvent(input: PricedUsageEventInput): PricedUsageEvent {
  const event = createUsageEvent(input);
  const costMode = input.costMode ?? (event.costUsd === undefined ? 'estimated' : 'explicit');

  if (costMode === 'explicit' && event.costUsd === undefined) {
    throw new Error('UsageEvent with costMode "explicit" requires costUsd');
  }

  return { ...event, costMode };
}
