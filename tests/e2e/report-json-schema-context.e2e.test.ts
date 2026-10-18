import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildContextReport } from '../../src/cli/run-context-report.js';
import { freezeDate } from '../golden/golden-harness.js';
import { createContextFixtureAdapters } from '../golden/m12-context-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

describe('context JSON schema', () => {
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

  const deps = { createAdapters: createContextFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true, json: true } as const;

  it.each([
    ['model rows', {}],
    ['session rows', { bySession: true }],
    ['logged costs only', { costMode: 'explicit' as const }],
    ['no usage', { repo: 'no-such-project' }],
  ])('validates %s', async (_, extra) => {
    validateReportOutput(
      validators,
      'context',
      await buildContextReport({ ...options, ...extra }, deps),
    );
  });
});
