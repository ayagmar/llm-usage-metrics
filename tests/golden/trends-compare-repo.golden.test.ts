import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCompareReport } from '../../src/cli/run-compare-report.js';
import { buildTrendsReport } from '../../src/cli/run-trends-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, freezeDate, useGoldenUpdateCheck } from './golden-harness.js';
import { M9_TC_GOLDEN_NAMES } from './m9-tc-names.js';
import { createProjectFixtureAdapters } from './m9-project-fixture.js';

const [trendsJson, compareJson, compareTerminal] = M9_TC_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

describe('trends and compare --by-repo goldens', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  useGoldenUpdateCheck(M9_TC_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true, byRepo: true } as const;
  // May holds only one of the two `api` roots; both windows still label it `a/api`.
  const compareWindows = {
    since: '2026-06-01',
    until: '2026-06-30',
    vsSince: '2026-05-01',
    vsUntil: '2026-05-31',
  } as const;

  it(`freezes ${trendsJson}`, async () => {
    const output = await buildTrendsReport(
      { ...options, since: '2026-06-14', until: '2026-06-16', json: true },
      deps,
    );

    await expectGolden(trendsJson, output);
  });

  it(`freezes ${compareJson}`, async () => {
    const output = await buildCompareReport({ ...options, ...compareWindows, json: true }, deps);

    await expectGolden(compareJson, output);
  });

  it(`freezes ${compareTerminal}`, async () => {
    const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
    let output: string;

    try {
      output = await buildCompareReport({ ...options, ...compareWindows }, deps);
    } finally {
      restoreStdout();
    }

    expect(output).not.toContain('\u001B[');
    await expectGolden(compareTerminal, output);
  });
});
