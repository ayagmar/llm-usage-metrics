import { describe, expect, it } from 'vitest';

import { aggregateUsage } from '../../src/aggregate/aggregate-usage.js';
import { sumDailyTotals } from '../../src/aggregate/daily-activity.js';
import {
  addEventToTotals,
  addTokenCostTotals,
  addTotals,
  createEmptyTotals,
  type TokenCostTotals,
} from '../../src/aggregate/usage-totals.js';
import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import { aggregateSessions } from '../../src/session/aggregate-sessions.js';
import { aggregateWrapped } from '../../src/wrapped/aggregate-wrapped.js';

function event(overrides: Partial<UsageEventInput>) {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-01-05T10:00:00.000Z',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costMode: 'estimated',
    ...overrides,
  });
}

// Costs that drift under plain addition, and one unpriced event.
const events = [
  event({ costUsd: 0.1, costMode: 'explicit' }),
  event({ costUsd: 0.2, timestamp: '2026-01-05T11:00:00.000Z' }),
  event({ costUsd: 0.7, sessionId: 'session-2', timestamp: '2026-03-02T09:00:00.000Z' }),
  event({ sessionId: 'session-2', timestamp: '2026-03-02T09:10:00.000Z', inputTokens: 7 }),
];

function pick({ totalTokens, costUsd, costIncomplete }: TokenCostTotals) {
  return { totalTokens, costUsd, costIncomplete };
}

describe('usage totals', () => {
  it('reaches the same total through every report surface', () => {
    const expected = createEmptyTotals();
    events.forEach((usageEvent) => {
      addEventToTotals(expected, usageEvent);
    });
    expect(pick(expected)).toEqual({ totalTokens: 60, costUsd: 1, costIncomplete: true });

    const grandTotal = aggregateUsage(events, {
      granularity: 'monthly',
      timezone: 'UTC',
    }).find((row) => row.rowType === 'grand_total');
    const sessions = createEmptyTotals();
    aggregateSessions(events).forEach((row) => {
      addTotals(sessions, row);
    });
    const days: TokenCostTotals = { totalTokens: 0 };
    sumDailyTotals(events, { from: '2026-01-01', to: '2026-12-31', timezone: 'UTC' }).forEach(
      (day) => {
        addTokenCostTotals(days, day);
      },
    );
    const recap = aggregateWrapped(events, { year: 2026, timezone: 'UTC' });

    expect(grandTotal).toMatchObject(expected);
    expect(sessions).toEqual(expected);
    expect(pick(days)).toEqual(pick(expected));
    expect(pick(recap)).toEqual(pick(expected));
  });
});
