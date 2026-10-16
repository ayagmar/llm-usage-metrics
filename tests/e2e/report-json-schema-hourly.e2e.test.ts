import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

type UsageJson = {
  report: string;
  data: { rowType: string; periodKey: string; source: string; repeatedHour?: boolean }[];
};

/** One pi and one codex event in each occurrence of New York's 2026-11-01 01:00. */
function fallBackAdapters(): SourceAdapter[] {
  return (['pi', 'codex'] as const).map((source) => ({
    id: source,
    discoverFiles: async () => [`/generated/${source}.jsonl`],
    read: readFrom(async () =>
      ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z', '2026-11-01T07:10:00.000Z'].map(
        (timestamp) =>
          createUsageEvent({
            source,
            sessionId: `${source}-session`,
            timestamp,
            provider: 'openai',
            model: 'gpt-5',
            inputTokens: 100,
            outputTokens: 10,
          }),
      ),
    ),
  }));
}

describe('hourly JSON schema', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = {
    timezone: 'Asia/Kolkata',
    pricingOffline: true,
    since: '2026-06-15',
    until: '2026-06-16',
    json: true,
  } as const;

  it('validates as a usage report with hour keys, split or not', async () => {
    for (const split of [{}, { byRepo: true, byMachine: true }]) {
      const output = await buildUsageReport('hourly', { ...options, ...split }, deps);
      const parsed = validateReportOutput(validators, 'usage', output) as UsageJson;
      const periodKeys = parsed.data
        .filter((row) => row.rowType !== 'grand_total')
        .map((row) => row.periodKey);

      expect(parsed.report).toBe('usage');
      expect(periodKeys.length).toBeGreaterThan(0);
      expect(periodKeys.every((key) => /^2026-06-1[56] \d{2}:00$/u.test(key))).toBe(true);
    }
  });

  it('marks the rows of a fall-back hour, and only those, with repeatedHour', async () => {
    const output = await buildUsageReport(
      'hourly',
      {
        timezone: 'America/New_York',
        pricingOffline: true,
        since: '2026-11-01',
        until: '2026-11-01',
        json: true,
      },
      { createAdapters: fallBackAdapters },
    );
    const parsed = validateReportOutput(validators, 'usage', output) as UsageJson;

    expect(
      parsed.data.map((row) => [row.periodKey, row.source, row.repeatedHour ?? false]),
    ).toEqual([
      ['2026-11-01 01:00', 'pi', true],
      ['2026-11-01 01:00', 'codex', true],
      ['2026-11-01 01:00', 'combined', true],
      ['2026-11-01 02:00', 'pi', false],
      ['2026-11-01 02:00', 'codex', false],
      ['2026-11-01 02:00', 'combined', false],
      ['ALL', 'combined', false],
    ]);
  });
});
