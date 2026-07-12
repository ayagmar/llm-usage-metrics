import { afterEach, describe, expect, it, vi } from 'vitest';

import { filterUsageEvents } from '../../../src/cli/parse/usage-event-filters.js';
import { createUsageEvent } from '../../../src/domain/usage-event.js';
import { getPeriodKey } from '../../../src/utils/time-buckets.js';

vi.mock('../../../src/utils/time-buckets.js', { spy: true });

afterEach(() => {
  vi.mocked(getPeriodKey).mockClear();
});

describe('usage-event-filters', () => {
  it('does not compute date buckets when no date filters are set', () => {
    const events = [
      createUsageEvent({
        source: 'pi',
        sessionId: 'early',
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTokens: 1,
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 'late',
        timestamp: '2026-01-02T00:00:00.000Z',
        totalTokens: 1,
      }),
    ];

    const filtered = filterUsageEvents(events, { timezone: 'UTC' });

    expect(filtered).toEqual(events);
    expect(vi.mocked(getPeriodKey)).not.toHaveBeenCalled();
  });

  it('memoizes date buckets by timestamp when date filters are set', () => {
    const events = [
      createUsageEvent({
        source: 'pi',
        sessionId: 'before-a',
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTokens: 1,
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 'on-start-a',
        timestamp: '2026-01-02T00:00:00.000Z',
        totalTokens: 1,
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 'on-start-b',
        timestamp: '2026-01-02T00:00:00.000Z',
        totalTokens: 1,
      }),
      createUsageEvent({
        source: 'pi',
        sessionId: 'before-b',
        timestamp: '2026-01-01T00:00:00.000Z',
        totalTokens: 1,
      }),
    ];

    const filtered = filterUsageEvents(events, {
      timezone: 'UTC',
      since: '2026-01-02',
    });

    expect(filtered.map((event) => event.sessionId)).toEqual(['on-start-a', 'on-start-b']);
    expect(vi.mocked(getPeriodKey)).toHaveBeenCalledTimes(2);
  });

  it('filters out events without model data when a model filter is active', () => {
    const filtered = filterUsageEvents(
      [
        createUsageEvent({
          source: 'pi',
          sessionId: 'missing-model',
          timestamp: '2026-02-01T00:00:00.000Z',
          totalTokens: 1,
        }),
        createUsageEvent({
          source: 'pi',
          sessionId: 'with-model',
          timestamp: '2026-02-01T00:00:00.000Z',
          model: 'gpt-4.1',
          totalTokens: 1,
        }),
      ],
      {
        timezone: 'UTC',
        modelFilter: ['gpt-4.1'],
      },
    );

    expect(filtered.map((event) => event.sessionId)).toEqual(['with-model']);
  });
});
