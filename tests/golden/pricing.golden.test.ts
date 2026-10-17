import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildPricingReport } from '../../src/cli/run-pricing-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, useGoldenUpdateCheck, WINDOWS_SKIP_REASON } from './golden-harness.js';
import { M9_PRICING_GOLDEN_NAMES } from './m9-pricing-names.js';

/** One name per resolution path the report explains, against the bundled snapshot. */
export const PRICING_GOLDEN_MODELS: readonly string[] = [
  // Direct key, with a one-hour cache write rate.
  'claude-sonnet-4-5-20250929',
  // The model map's alias and preferred key.
  'k2p5',
  // Effort suffix dropped; the key has a long-context tier above 272k.
  'gpt-5.4-high',
  'deepseek-v3.2',
  'gpt52codex',
  // Back-filled from retired prices.
  'claude-3-7-sonnet-20250219',
  // Tier above 200k.
  'gemini-2.5-pro',
  // Priority rates stand in for the missing standard rates.
  'fireworks_ai/accounts/fireworks/models/minimax-m2p7',
  'gpt-5-codex-mini',
  // Override keyed on the name.
  'acme-internal-model',
  // Resolves to claude-opus-4-8, which an override is keyed on.
  'claude-opus-4-8-thinking',
  '  GPT-5.5  ',
];

const overridesPath = path.resolve('tests/fixtures/pricing/explain-overrides.json');

const TERMINAL_COLUMNS = 120;

const formats = [
  ['reports/pricing.json', { json: true }],
  ['reports/pricing.md', { markdown: true }],
  ['reports/pricing.txt', {}],
] as const;

// Skipped on Windows: newline handling differs there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`pricing goldens (${WINDOWS_SKIP_REASON})`, () => {
  useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();
  useGoldenUpdateCheck(M9_PRICING_GOLDEN_NAMES);

  for (const [goldenName, formatFlags] of formats) {
    it(`freezes ${goldenName}`, async () => {
      const restoreStdout = goldenName.endsWith('.txt')
        ? overrideStdoutTty(TERMINAL_COLUMNS)
        : undefined;
      let output: string;

      try {
        output = await buildPricingReport(PRICING_GOLDEN_MODELS, {
          pricingOffline: true,
          pricingOverrides: overridesPath,
          ...formatFlags,
        });
      } finally {
        restoreStdout?.();
      }

      expect(output).not.toContain('\u001B[');
      expect(pricing.fetch).not.toHaveBeenCalled();
      await expectGolden(goldenName, output);
    });
  }
});
