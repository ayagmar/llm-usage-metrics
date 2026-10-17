import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, freezeDate, useGoldenUpdateCheck } from './golden-harness.js';
import { M9_USAGE_GOLDEN_NAMES } from './m9-usage-names.js';
import { createProjectFixtureAdapters } from './m9-project-fixture.js';

const [byRepoJson, byRepoTerminal, repoFilterJson] = M9_USAGE_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

describe('usage --by-repo and --repo goldens', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  useGoldenUpdateCheck(M9_USAGE_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true } as const;

  it(`freezes ${byRepoJson}`, async () => {
    const output = await buildUsageReport(
      'daily',
      { ...options, all: true, byRepo: true, json: true },
      deps,
    );

    await expectGolden(byRepoJson, output);
  });

  it(`freezes ${byRepoTerminal}`, async () => {
    const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
    let output: string;

    try {
      output = await buildUsageReport('daily', { ...options, all: true, byRepo: true }, deps);
    } finally {
      restoreStdout();
    }

    expect(output).not.toContain('\u001B[');
    await expectGolden(byRepoTerminal, output);
  });

  it(`freezes ${repoFilterJson}`, async () => {
    const output = await buildUsageReport('monthly', { ...options, repo: 'api', json: true }, deps);

    await expectGolden(repoFilterJson, output);
  });
});
