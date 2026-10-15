import { describe, expect, it, vi } from 'vitest';

import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import {
  applyPricingToEvents,
  createPricingRunStats,
  DEFAULT_PRICING_POLICY,
  type PricingCostMode,
} from '../../src/pricing/cost-engine.js';
import { StaticPricingSource } from '../helpers/static-pricing-source.js';

const pricingSource = new StaticPricingSource({
  pricingByModel: {
    'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
    'input-only-model': { inputPer1MUsd: 1 },
  },
});

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}): UsageEvent {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-02-16T10:00:00Z',
    model: 'gpt-5-codex',
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  });
}

function priceWithMode(events: UsageEvent[], costMode: PricingCostMode) {
  const stats = createPricingRunStats();
  const pricedEvents = applyPricingToEvents(events, pricingSource, {
    policy: { ...DEFAULT_PRICING_POLICY, costMode },
    stats,
  });

  return { pricedEvents, stats };
}

describe('cost engine cost modes', () => {
  it('explicit keeps a logged $0 at $0 and leaves events without a logged cost unpriced', () => {
    const loggedZero = createEvent({ costUsd: 0, costMode: 'explicit' });
    const logged = createEvent({ costUsd: 1.23, costMode: 'explicit' });
    const notLogged = createEvent();
    const { pricedEvents, stats } = priceWithMode([loggedZero, logged, notLogged], 'explicit');

    expect(pricedEvents.map((event) => [event.costUsd, event.costMode])).toEqual([
      [0, 'explicit'],
      [1.23, 'explicit'],
      [undefined, 'estimated'],
    ]);
    expect(stats.reestimatedExplicitZero.has(pricedEvents[0])).toBe(false);
  });

  it('explicit drops a cost that was estimated earlier rather than present it as logged', () => {
    const preEstimated = { ...createEvent(), costUsd: 0.5, costMode: 'estimated' as const };
    const [pricedEvent] = priceWithMode([preEstimated], 'explicit').pricedEvents;

    expect(pricedEvent.costUsd).toBeUndefined();
    expect(pricedEvent).not.toHaveProperty('costUsd');
  });

  it('explicit never looks up model prices', () => {
    const getPricing = vi.fn(() => ({ inputPer1MUsd: 1, outputPer1MUsd: 2 }));

    applyPricingToEvents(
      [createEvent()],
      { resolveModelAlias: (model) => model, getPricing },
      {
        policy: { ...DEFAULT_PRICING_POLICY, costMode: 'explicit' },
        stats: createPricingRunStats(),
      },
    );

    expect(getPricing).not.toHaveBeenCalled();
  });

  it('estimated prices logged costs from tokens, including a logged $0', () => {
    const logged = createEvent({ costUsd: 9, costMode: 'explicit' });
    const loggedZero = createEvent({ costUsd: 0, costMode: 'explicit' });
    const { pricedEvents, stats } = priceWithMode([logged, loggedZero], 'estimated');

    for (const pricedEvent of pricedEvents) {
      expect(pricedEvent.costMode).toBe('estimated');
      expect(pricedEvent.costUsd).toBeCloseTo(0.0002, 10);
    }

    // Only `both` re-estimates a logged $0 against the user's default; `estimated` was asked for.
    expect(stats.reestimatedExplicitZero.has(pricedEvents[1])).toBe(false);
  });

  it('estimated leaves an event unpriced when it cannot price it, never keeping the logged cost', () => {
    const unknownModel = createEvent({ model: 'unknown-model', costUsd: 9, costMode: 'explicit' });
    const missingRate = createEvent({
      model: 'input-only-model',
      costUsd: 0,
      costMode: 'explicit',
    });
    const noModel = createEvent({ model: undefined, costUsd: 4, costMode: 'explicit' });
    const { pricedEvents } = priceWithMode([unknownModel, missingRate, noModel], 'estimated');

    expect(pricedEvents.map((event) => [event.costUsd, event.costMode])).toEqual([
      [undefined, 'estimated'],
      [undefined, 'estimated'],
      [undefined, 'estimated'],
    ]);
  });

  it('both keeps a logged $0 when it cannot price the model, without recording it', () => {
    const loggedZero = createEvent({ model: 'unknown-model', costUsd: 0, costMode: 'explicit' });
    const { pricedEvents, stats } = priceWithMode([loggedZero], 'both');

    expect(pricedEvents[0]).toBe(loggedZero);
    expect(stats.reestimatedExplicitZero.has(loggedZero)).toBe(false);
  });
});
