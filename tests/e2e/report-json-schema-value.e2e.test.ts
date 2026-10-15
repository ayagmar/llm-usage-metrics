import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildValueReportOutput } from '../../src/cli/run-value-report.js';
import { freezeDate } from '../golden/golden-harness.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

type ValueJson = { data: { plans: { months: Record<string, unknown>[] }[] } };

describe('value JSON schema', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    freezeDate();
    validators = compileReportValidators();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true, json: true } as const;

  it.each([
    ['two plans over full history', { plan: ['claude-max-20x', 'chatgpt-plus'] }],
    ['an overridden price with idle months', { planPrice: '18', since: '2026-03-10' }],
    ['incomplete costs', { costMode: 'explicit' as const }],
    ['no usage', { repo: 'no-such-project' }],
  ])('validates %s', async (_, extra) => {
    const output = await buildValueReportOutput({ ...options, ...extra }, deps);

    validateReportOutput(validators, 'value', output);
  });

  it('rejects an unknown month field', async () => {
    const output = await buildValueReportOutput(options, deps);
    const parsed = JSON.parse(output) as ValueJson;
    const validate = validators.get('value');
    const month = parsed.data.plans[0]?.months[0];

    expect(month).toBeDefined();
    parsed.data.plans[0]?.months.splice(0, 1, { ...month, prorated: true });

    expect(validate?.(parsed)).toBe(false);
  });
});
