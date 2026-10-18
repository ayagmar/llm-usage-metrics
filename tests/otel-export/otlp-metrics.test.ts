import { describe, expect, it } from 'vitest';

import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import { buildOtlpMetrics, type OtlpMetricsData } from '../../src/otel-export/otlp-metrics.js';

function event(timestamp: string, overrides: Partial<UsageEventInput> = {}) {
  return createUsageEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp,
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costMode: 'explicit',
    costUsd: 1,
    ...overrides,
  });
}

function metricsOf(data: OtlpMetricsData) {
  return data.resourceMetrics[0].scopeMetrics[0].metrics;
}

describe('buildOtlpMetrics', () => {
  it('bounds a DST day by its local midnights, 23 hours apart', () => {
    const [data] = buildOtlpMetrics({
      usageEvents: [event('2026-03-08T12:00:00.000Z')],
      timezone: 'America/New_York',
    });
    const [point] = metricsOf(data)[0].sum.dataPoints;

    expect(point.startTimeUnixNano).toBe(`${Date.parse('2026-03-08T05:00:00.000Z')}000000`);
    expect(point.timeUnixNano).toBe(`${Date.parse('2026-03-09T04:00:00.000Z')}000000`);
  });

  it('leaves the cost metric out when no event in the day is priced', () => {
    const [data] = buildOtlpMetrics({
      usageEvents: [event('2026-03-08T12:00:00.000Z', { costUsd: undefined, costMode: undefined })],
      timezone: 'UTC',
    });

    expect(metricsOf(data).map((metric) => metric.name)).not.toContain('llm_usage.cost_usd');
  });

  it('gives the same bytes whatever order the events arrive in', () => {
    const events = [
      event('2026-03-08T12:00:00.000Z', { model: 'gpt-5' }),
      { ...event('2026-03-08T13:00:00.000Z'), machine: 'laptop' },
      event('2026-03-09T12:00:00.000Z', { source: 'claude', provider: 'anthropic' }),
      event('2026-03-08T14:00:00.000Z'),
      event('2026-03-08T15:00:00.000Z'),
    ];
    const forward = buildOtlpMetrics({ usageEvents: events, timezone: 'UTC' });
    const backward = buildOtlpMetrics({ usageEvents: [...events].reverse(), timezone: 'UTC' });

    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(forward).toHaveLength(2);
    expect(
      metricsOf(forward[0])[0].sum.dataPoints.map((point) =>
        'asInt' in point ? point.asInt : undefined,
      ),
    ).toEqual(['20', '10', '10']);
  });
});
