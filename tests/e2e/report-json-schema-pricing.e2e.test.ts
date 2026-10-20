import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv';

import { buildPricingReport } from '../../src/cli/run-pricing-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

const overridesPath = path.resolve('packages/core/tests/fixtures/pricing/explain-overrides.json');

describe('pricing --json schema', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  let validators: Map<string, ValidateFunction>;

  beforeAll(() => {
    validators = compileReportValidators();
  });

  it('validates priced, tiered, retired, overridden and unpriced names', async () => {
    const output = await buildPricingReport(
      [
        'gemini-2.5-pro',
        'claude-3-7-sonnet-20250219',
        'fireworks_ai/accounts/fireworks/models/minimax-m2p7',
        'gpt52codex',
        'acme-internal-model',
        'claude-opus-4-8-thinking',
        'gpt-5-codex-mini',
      ],
      { json: true, pricingOffline: true, pricingOverrides: overridesPath },
    );

    const parsed = validateReportOutput(validators, 'pricing', output) as {
      data: { models: { pricingKey: string | null }[] };
    };
    expect(parsed.data.models.map((model) => model.pricingKey)).toEqual([
      'gemini-2.5-pro',
      'claude-3-7-sonnet-20250219',
      'fireworks_ai/accounts/fireworks/models/minimax-m2p7',
      'gpt-5.2-codex',
      'acme-internal-model',
      'claude-opus-4-8',
      null,
    ]);
  });

  it('rejects a payload with a field the schema does not define', () => {
    const validate = validators.get('pricing');
    const payload = {
      schemaVersion: 1,
      report: 'pricing',
      data: { models: [], extra: true },
    };

    expect(validate?.(payload)).toBe(false);
  });
});
