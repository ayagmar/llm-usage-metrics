import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
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

  it('validates the row folding the projects past --top, as limited as the table', async () => {
    const output = await buildUsageReport('monthly', { ...options, byRepo: true, top: '1' }, deps);
    const parsed = validateReportOutput(validators, 'usage', output) as UsageJson;
    const otherRows = parsed.data.filter((row) => row.otherProjects !== undefined);

    expect(otherRows.length).toBeGreaterThan(0);
    expect(otherRows.every((row) => !('repoRoot' in row))).toBe(true);
  });

  it('names the fold on stderr, ranked by tokens with --no-cost', async () => {
    const tableOptions = {
      timezone: 'UTC',
      pricingOffline: true,
      all: true,
      byRepo: true,
      top: '1',
    };
    const priced = await buildUsageData('monthly', tableOptions, deps);
    const noCost = await buildUsageData('monthly', { ...tableOptions, cost: false }, deps);
    const all = await buildUsageData('monthly', { ...tableOptions, top: '0' }, deps);

    expect(priced.limitNote).toBe(
      'Showing the top 1 projects of each month by cost (by tokens where a cost is incomplete); the rest are folded into "other projects" rows. Use --top 0 for all.',
    );
    expect(noCost.limitNote).toContain('of each month by tokens;');
    expect(all.limitNote).toBeUndefined();
  });

  it('rejects --top without --by-repo', async () => {
    await expect(buildUsageReport('daily', { ...options, top: '5' }, deps)).rejects.toThrow(
      '--top applies with --by-repo',
    );
  });

  it('rejects a project field of the wrong type', async () => {
    const output = await buildUsageReport('monthly', { ...options, byRepo: true }, deps);
    const parsed = JSON.parse(output) as UsageJson;
    const validate = validators.get('usage');

    parsed.data[0] = { ...parsed.data[0], repoRoot: 42 };

    expect(validate?.(parsed)).toBe(false);
  });
});
