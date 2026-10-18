import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, freezeDate, useGoldenUpdateCheck } from './golden-harness.js';
import { M9_HOURLY_GOLDEN_NAMES } from './m9-hourly-names.js';
import { createProjectFixtureAdapters } from './m9-project-fixture.js';

const [hourlyJson, hourlyMarkdown, hourlyTerminal] = M9_HOURLY_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

describe('hourly report goldens', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  useGoldenUpdateCheck(M9_HOURLY_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = {
    timezone: 'UTC',
    pricingOffline: true,
    since: '2026-06-15',
    until: '2026-06-15',
  } as const;

  it(`freezes ${hourlyJson}`, async () => {
    const output = await buildUsageReport('hourly', { ...options, json: true }, deps);

    await expectGolden(hourlyJson, output);
  });

  it(`freezes ${hourlyMarkdown}`, async () => {
    const output = await buildUsageReport('hourly', { ...options, markdown: true }, deps);

    await expectGolden(hourlyMarkdown, output);
  });

  it(`freezes ${hourlyTerminal}`, async () => {
    const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
    let output: string;

    try {
      output = await buildUsageReport('hourly', options, deps);
    } finally {
      restoreStdout();
    }

    expect(output).not.toContain('\u001B[');
    await expectGolden(hourlyTerminal, output);
  });
});
