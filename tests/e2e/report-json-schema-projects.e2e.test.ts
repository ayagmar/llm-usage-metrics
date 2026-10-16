import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildProjectsReport } from '../../src/cli/run-projects-report.js';
import type { ProjectsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

type ProjectsJson = {
  data: { projects: Record<string, unknown>[]; periods?: Record<string, unknown>[] };
};

describe('projects JSON schema', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true, json: true } as const;
  const run = (extra: Partial<ProjectsCommandOptions>) =>
    buildProjectsReport({ ...options, ...extra }, deps);

  it.each<[string, Partial<ProjectsCommandOptions>]>([
    ['full history', {}],
    ['daily periods', { granularity: 'daily' }],
    ['weekly periods with --top', { granularity: 'weekly', top: '2' }],
    ['--repo', { repo: ['api'] }],
    ['--repo (unattributed)', { repo: ['(unattributed)'] }],
    ['--cost-mode explicit (nothing priced)', { costMode: 'explicit' }],
    ['an empty window', { granularity: 'monthly', since: '2020-01-01', until: '2020-01-31' }],
  ])('validates %s', async (_name, extra) => {
    const parsed = validateReportOutput(validators, 'projects', await run(extra)) as ProjectsJson;

    expect(parsed.data.periods !== undefined).toBe(extra.granularity !== undefined);
  });

  it('rejects an unknown project field and a wrong root type', async () => {
    const parsed = JSON.parse(await run({ granularity: 'monthly' })) as {
      data: Required<ProjectsJson['data']>;
    };
    const validate = validators.get('projects');
    const withExtraField = structuredClone(parsed);
    const withNumericRoot = structuredClone(parsed);

    withExtraField.data.projects[0] = { ...parsed.data.projects[0], eventCount: 1 };
    withNumericRoot.data.periods[0] = { ...parsed.data.periods[0], repoRoot: 42 };

    expect(validate?.(withExtraField)).toBe(false);
    expect(validate?.(withNumericRoot)).toBe(false);
  });
});
