import { describe, expect, it } from 'vitest';

import { resolveAndApplyPricingToEvents } from '../../src/cli/build-usage-data-pricing.js';
import { withPricingNotes } from '../../src/cli/build-usage-event-dataset.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { StaticPricingSource } from '../../packages/core/tests/helpers/static-pricing-source.js';

function loggedZeroEvent(source: string) {
  return createUsageEvent({
    source,
    sessionId: `${source}-session`,
    timestamp: '2026-02-16T10:00:00Z',
    model: 'gpt-4.1',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0,
    costMode: 'explicit',
  });
}

async function priceEvents(events: ReturnType<typeof loggedZeroEvent>[]) {
  return resolveAndApplyPricingToEvents(
    events,
    {},
    {
      loadPricingSource: async () => ({
        source: new StaticPricingSource({
          pricingByModel: { 'gpt-4.1': { inputPer1MUsd: 2, outputPer1MUsd: 8 } },
        }),
        origin: 'cache',
      }),
    },
  );
}

describe('withPricingNotes logged $0 note', () => {
  it('counts only the shown events and lists their sources in order', async () => {
    const pricingResult = await priceEvents([
      loggedZeroEvent('pi'),
      loggedZeroEvent('codex'),
      loggedZeroEvent('pi'),
      loggedZeroEvent('claude'),
    ]);
    const shownEvents = pricingResult.pricedEvents.slice(0, 3);

    expect(withPricingNotes(['dataset note'], shownEvents, pricingResult)).toEqual([
      'dataset note',
      {
        verbose:
          '3 events logged $0 by codex, pi were estimated from LiteLLM; use --cost-mode explicit to keep $0',
      },
    ]);
  });
});
