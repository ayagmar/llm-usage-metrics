import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { describe, expect, it } from 'vitest';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import { buildSummaryReport } from '../../src/cli/run-summary-report.js';
import { buildTrendsReport } from '../../src/cli/run-trends-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { buildValueReportOutput } from '../../src/cli/run-value-report.js';
import { buildWrappedReport } from '../../src/cli/run-wrapped-report.js';
import type { BuildUsageDataDeps } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { DAY_MS } from '../../src/utils/time-constants.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');
const BASE = { timezone: 'UTC', pricingOffline: true } as const;

const createAdapters = (): SourceAdapter[] => [
  {
    id: 'claude',
    discoverFiles: async () => ['/run-clock-test/claude.jsonl'],
    read: readFrom(async () => [
      createUsageEvent({
        source: 'claude',
        sessionId: 's',
        timestamp: '2026-06-21T10:15:00.000Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 1_000,
        outputTokens: 100,
      }),
    ]),
  },
];

// --share-json builds the share page too, which reads the window a second time.
const reports: [string, (deps: BuildUsageDataDeps) => Promise<string>][] = [
  ['daily --share-json', (deps) => buildUsageReport('daily', { ...BASE, shareJson: true }, deps)],
  ['summary --share-json', (deps) => buildSummaryReport({ ...BASE, shareJson: true }, deps)],
  ['compare --share-json', (deps) => buildCompareReport({ ...BASE, shareJson: true }, deps)],
  ['trends --share-json', (deps) => buildTrendsReport({ ...BASE, shareJson: true }, deps)],
  ['wrapped --share-json', (deps) => buildWrappedReport({ ...BASE, shareJson: true }, deps)],
  ['value', (deps) => buildValueReportOutput({ ...BASE, json: true }, deps)],
];

describe('report clock', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  it.each(reports)('%s reads the clock once per run', async (_name, build) => {
    // Each read is a day later, so a second read would put part of the report on another day.
    let reads = 0;

    await build({
      now: () => new Date(NOW.getTime() + reads++ * DAY_MS),
      createAdapters,
      getEventStoreRuntimeConfig: () => ({
        enabled: false,
        path: '',
        disabledBy: 'configuration',
      }),
    });

    expect(reads).toBe(1);
  });
});
