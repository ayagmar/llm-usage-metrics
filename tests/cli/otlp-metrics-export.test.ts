import { beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { runEventsReport } from '../../src/cli/run-events-report.js';
import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import type { PeriodSourceRow } from '../../src/domain/usage-report-row.js';
import type { OtlpMetricsData } from '../../src/otel-export/otlp-metrics.js';
import { addUsd } from '../../src/utils/usd-math.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  fixedNow,
  type SourceOptions,
} from '../golden/golden-harness.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

type DayTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd?: number;
};

async function exportMetrics(options: EventsCommandOptions): Promise<OtlpMetricsData[]> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await runEventsReport({ ...options, format: 'otlp-metrics' }, { now: fixedNow });
  } finally {
    vi.restoreAllMocks();
  }

  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OtlpMetricsData);
}

function toDayKey(epochNanos: string, timezone: string): string {
  return new Date(Number(BigInt(epochNanos) / 1_000_000n)).toLocaleDateString('en-CA', {
    timeZone: timezone,
  });
}

/** Per `day/agent`, the export's points summed back into daily totals. */
function totalsFromMetrics(lines: readonly OtlpMetricsData[], timezone: string) {
  const totals = new Map<string, DayTotals>();
  const fields: Record<string, keyof DayTotals> = {
    'gen_ai.client.inference.usage.input_tokens': 'input',
    'gen_ai.client.inference.usage.output_tokens': 'output',
    'gen_ai.client.inference.usage.cache_read.input_tokens': 'cacheRead',
    'gen_ai.client.inference.usage.cache_write.input_tokens': 'cacheWrite',
    'gen_ai.client.inference.usage.reasoning.output_tokens': 'reasoning',
    'llm_usage.cost_usd': 'costUsd',
  };

  for (const line of lines) {
    const [resourceMetrics] = line.resourceMetrics;
    const agent = resourceMetrics.resource.attributes[0]?.value;

    for (const metric of resourceMetrics.scopeMetrics[0].metrics) {
      const field = fields[metric.name];

      for (const point of metric.sum.dataPoints) {
        const key = `${toDayKey(point.startTimeUnixNano, timezone)}/${JSON.stringify(agent)}`;
        const day = totals.get(key) ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        };
        day[field] =
          'asInt' in point
            ? (day[field] ?? 0) + Number(point.asInt)
            : addUsd(day[field] ?? 0, point.asDouble);
        totals.set(key, day);
      }
    }
  }

  return totals;
}

/** Per `day/agent`, the `daily` report's source rows. */
async function totalsFromDaily(options: EventsCommandOptions) {
  const { rows } = await buildUsageData('daily', options, { now: fixedNow });
  const totals = new Map<string, DayTotals>();

  for (const row of rows.filter((row): row is PeriodSourceRow => row.rowType === 'period_source')) {
    const agent = { stringValue: row.source === 'claude' ? 'claude-code' : row.source };
    totals.set(`${row.periodKey}/${JSON.stringify(agent)}`, {
      input: row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens,
      reasoning: row.reasoningTokens,
      ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
    });
  }

  return totals;
}

describe('events --format otlp-metrics', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();
  let e2eOptions: SourceOptions;

  beforeAll(async () => {
    e2eOptions = await createE2eSourceOptions(environment.rootDir);
  });

  // A timezone far from UTC moves events across midnight, so a UTC bucket would not match.
  it.each([
    ['every source', 'Pacific/Kiritimati', {}],
    [
      'one source from a date',
      'America/New_York',
      { all: false, source: 'claude,codex', since: '2026-01-01', until: '2026-06-30' },
    ],
  ])('sums to the daily report per day and agent: %s', async (_label, timezone, filters) => {
    const options: EventsCommandOptions = {
      ...e2eOptions,
      source: ALL_SOURCE_IDS.join(','),
      all: true,
      timezone,
      pricingOffline: true,
      ...filters,
    };

    const fromMetrics = totalsFromMetrics(await exportMetrics(options), timezone);
    const fromDaily = await totalsFromDaily(options);

    expect(fromMetrics.size).toBeGreaterThan(1);
    expect(fromMetrics).toEqual(fromDaily);
  });

  it('rejects --otel-include-paths: paths would split every point', async () => {
    await expect(
      runEventsReport({ format: 'otlp-metrics', otelIncludePaths: true }),
    ).rejects.toThrow('--otel-include-paths needs --format otlp-traces');
  });
});
