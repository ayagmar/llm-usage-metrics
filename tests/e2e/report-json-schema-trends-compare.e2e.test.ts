import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import { buildTrendsReport } from '../../src/cli/run-trends-report.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

type TrendsJson = { data: { projectSeries: Record<string, unknown>[] } };
type CompareJson = { data: { projects: Record<string, unknown>[] } };

describe('trends and compare --by-repo JSON schema', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true, byRepo: true, json: true } as const;
  const compareWindows = {
    since: '2026-06-01',
    until: '2026-06-30',
    vsSince: '2026-05-01',
    vsUntil: '2026-05-31',
  } as const;

  it('validates per-project trend series for every metric', async () => {
    for (const metric of ['cost', 'tokens', 'active-hours']) {
      const output = await buildTrendsReport(
        { ...options, since: '2026-05-20', until: '2026-06-15', metric },
        deps,
      );
      const parsed = validateReportOutput(validators, 'trends', output) as TrendsJson;

      expect(parsed.data.projectSeries.map((series) => series.repoRoot)).toContain(null);
    }
  });

  it('validates per-project compare rows', async () => {
    const output = await buildCompareReport({ ...options, ...compareWindows }, deps);
    const parsed = validateReportOutput(validators, 'compare', output) as CompareJson;

    expect(parsed.data.projects.map((row) => row.repoRoot)).toContain(null);
  });

  it('validates the compare row folding the projects past --top', async () => {
    const output = await buildCompareReport({ ...options, ...compareWindows, top: '1' }, deps);
    const parsed = validateReportOutput(validators, 'compare', output) as CompareJson;

    expect(parsed.data.projects).toHaveLength(2);
    expect(parsed.data.projects[1]).toHaveProperty('otherProjects');
  });

  it('rejects a project row of the wrong shape', async () => {
    const trends = JSON.parse(
      await buildTrendsReport({ ...options, since: '2026-06-15', until: '2026-06-15' }, deps),
    ) as TrendsJson;
    const compare = JSON.parse(
      await buildCompareReport({ ...options, ...compareWindows }, deps),
    ) as CompareJson;

    trends.data.projectSeries[0] = { ...trends.data.projectSeries[0], source: 'claude' };
    compare.data.projects[0] = { ...compare.data.projects[0], repoRoot: 42 };

    expect(validators.get('trends')?.(trends)).toBe(false);
    expect(validators.get('compare')?.(compare)).toBe(false);

    // A project row names its project, or counts the projects it folds.
    const unnamed = { ...compare.data.projects[1] };
    delete unnamed.repoRoot;
    compare.data.projects = [unnamed];
    expect(validators.get('compare')?.(compare)).toBe(false);
  });
});
