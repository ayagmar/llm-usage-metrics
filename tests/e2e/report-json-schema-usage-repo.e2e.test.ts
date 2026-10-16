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

type UsageJson = { data: Record<string, unknown>[] };

describe('usage --by-repo JSON schema', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true, all: true, json: true } as const;

  it('validates per-project rows, unattributed ones included, with and without --by-machine', async () => {
    for (const byMachine of [false, true]) {
      const output = await buildUsageReport(
        'weekly',
        { ...options, byRepo: true, byMachine },
        deps,
      );
      const parsed = validateReportOutput(validators, 'usage', output) as UsageJson;
      const sourceRows = parsed.data.filter((row) => row.rowType === 'period_source');

      expect(sourceRows.map((row) => row.repoRoot)).toContain(null);
      expect(sourceRows.every((row) => typeof row.project === 'string')).toBe(true);
      expect(sourceRows.every((row) => 'machine' in row)).toBe(byMachine);
    }
  });

  it('rejects a project field of the wrong type', async () => {
    const output = await buildUsageReport('monthly', { ...options, byRepo: true }, deps);
    const parsed = JSON.parse(output) as UsageJson;
    const validate = validators.get('usage');

    parsed.data[0] = { ...parsed.data[0], repoRoot: 42 };

    expect(validate?.(parsed)).toBe(false);
  });
});
