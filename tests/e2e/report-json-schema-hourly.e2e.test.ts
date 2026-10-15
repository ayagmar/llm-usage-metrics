import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

type UsageJson = { report: string; data: { rowType: string; periodKey: string }[] };

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
});
