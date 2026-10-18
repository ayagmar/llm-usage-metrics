import { createToolCallEvent, type ToolCallEventInput } from '@ayagmar/agent-sessions';
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

function toolCall(timestamp: string, overrides: Partial<ToolCallEventInput> = {}) {
  return createToolCallEvent({
    source: 'codex',
    sessionId: 'session-1',
    timestamp,
    name: 'shell',
    status: 'ok',
    ...overrides,
  });
}

function metricsOf(data: OtlpMetricsData) {
  return data.resourceMetrics[0].scopeMetrics[0].metrics;
}

function metricNamed(data: OtlpMetricsData, name: string) {
  const metric = metricsOf(data).find((candidate) => candidate.name === name);

  if (metric === undefined) {
    throw new Error(`no ${name} metric`);
  }

  return metric;
}

function sumPoints(data: OtlpMetricsData, name: string) {
  const metric = metricNamed(data, name);

  if (!('sum' in metric)) {
    throw new Error(`${name} is not a sum`);
  }

  return metric.sum.dataPoints;
}

function histogramPoints(data: OtlpMetricsData, name: string) {
  const metric = metricNamed(data, name);

  if (!('histogram' in metric)) {
    throw new Error(`${name} is not a histogram`);
  }

  return metric.histogram.dataPoints;
}

describe('buildOtlpMetrics', () => {
  it('bounds a DST day by its local midnights, 23 hours apart', () => {
    const [data] = buildOtlpMetrics({
      usageEvents: [event('2026-03-08T12:00:00.000Z')],
      toolCalls: [],
      timezone: 'America/New_York',
    });
    const [point] = sumPoints(data, 'gen_ai.client.inference.usage.input_tokens');

    expect(point.startTimeUnixNano).toBe(`${Date.parse('2026-03-08T05:00:00.000Z')}000000`);
    expect(point.timeUnixNano).toBe(`${Date.parse('2026-03-09T04:00:00.000Z')}000000`);
  });

  it('leaves the cost metric out when no event in the day is priced', () => {
    const [data] = buildOtlpMetrics({
      usageEvents: [event('2026-03-08T12:00:00.000Z', { costUsd: undefined, costMode: undefined })],
      toolCalls: [],
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
    const calls = [
      toolCall('2026-03-08T12:00:00.000Z', { durationMs: 1500 }),
      toolCall('2026-03-08T12:01:00.000Z', { durationMs: 30 }),
      toolCall('2026-03-08T12:02:00.000Z', { durationMs: 70, status: 'error' }),
    ];
    const forward = buildOtlpMetrics({ usageEvents: events, toolCalls: calls, timezone: 'UTC' });
    const backward = buildOtlpMetrics({
      usageEvents: [...events].reverse(),
      toolCalls: [...calls].reverse(),
      timezone: 'UTC',
    });

    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
    expect(forward).toHaveLength(2);
    expect(
      sumPoints(forward[0], 'gen_ai.client.inference.usage.input_tokens').map((point) =>
        'asInt' in point ? point.asInt : undefined,
      ),
    ).toEqual(['20', '10', '10']);
  });

  it('puts each inference in the bucket whose upper bound is the first at or above it', () => {
    const [data] = buildOtlpMetrics({
      // Input tokens 4 (on the bound), 5 (just past it) and 70M (past the last bound).
      usageEvents: [
        event('2026-03-08T12:00:00.000Z', { inputTokens: 4, outputTokens: 0, totalTokens: 4 }),
        event('2026-03-08T13:00:00.000Z', { inputTokens: 3, cacheReadTokens: 2, totalTokens: 10 }),
        event('2026-03-08T14:00:00.000Z', { inputTokens: 70_000_000, totalTokens: 70_000_005 }),
      ],
      toolCalls: [],
      timezone: 'UTC',
    });
    const [input] = histogramPoints(data, 'gen_ai.client.inference.operation.input_tokens');
    const [output] = histogramPoints(data, 'gen_ai.client.inference.operation.output_tokens');

    expect(input.count).toBe('3');
    expect(input.sum).toBe(70_000_009);
    expect([input.min, input.max]).toEqual([4, 70_000_000]);
    expect(input.bucketCounts).toEqual([
      '0',
      '1',
      '1',
      ...Array.from({ length: 11 }, () => '0'),
      '1',
    ]);
    // The histograms are not split by modality; the counters are.
    expect(input.attributes.map((attribute) => attribute.key)).not.toContain(
      'gen_ai.token.modality',
    );
    expect(output.bucketCounts.slice(0, 3)).toEqual(['1', '0', '2']);
  });

  it('records tool durations in seconds, only for calls whose end the log gives', () => {
    const [usageDay, toolOnlyDay] = buildOtlpMetrics({
      usageEvents: [event('2026-03-08T12:00:00.000Z')],
      toolCalls: [
        toolCall('2026-03-08T12:00:00.000Z', { durationMs: 1500 }),
        toolCall('2026-03-08T12:00:01.000Z', { completedAt: '2026-03-08T12:00:01.250Z' }),
        toolCall('2026-03-08T12:00:02.000Z', { durationMs: 40, status: 'error' }),
        // No end, and an end equal to the start: neither has a measured duration.
        toolCall('2026-03-08T12:00:03.000Z'),
        toolCall('2026-03-08T12:00:04.000Z', { completedAt: '2026-03-08T12:00:04.000Z' }),
        // Past midnight: it counts in the day it started, which has no usage.
        toolCall('2026-03-09T00:30:00.000Z', { name: 'apply_patch', durationMs: 10 }),
      ],
      timezone: 'UTC',
    });
    const [ok, failed] = histogramPoints(usageDay, 'gen_ai.execute_tool.duration');

    expect(ok.attributes).toEqual([
      { key: 'gen_ai.tool.name', value: { stringValue: 'shell' } },
      { key: 'gen_ai.agent.name', value: { stringValue: 'codex' } },
    ]);
    expect([ok.count, ok.sum, ok.min, ok.max]).toEqual(['2', 1.75, 0.25, 1.5]);
    expect(ok.explicitBounds.slice(0, 3)).toEqual([0.01, 0.02, 0.04]);
    expect(failed.attributes.at(-1)).toEqual({
      key: 'error.type',
      value: { stringValue: '_OTHER' },
    });
    expect(failed.count).toBe('1');
    expect(metricsOf(toolOnlyDay).map((metric) => metric.name)).toEqual([
      'gen_ai.execute_tool.duration',
    ]);
  });
});
