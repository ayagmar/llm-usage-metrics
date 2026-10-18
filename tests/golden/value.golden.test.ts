import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildValueReportOutput } from '../../src/cli/run-value-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, freezeDate, useGoldenUpdateCheck } from './golden-harness.js';
import { M9_VALUE_GOLDEN_NAMES } from './m9-value-names.js';
import { createProjectFixtureAdapters } from './m9-project-fixture.js';

const [valueJson, valueMarkdown, valueTerminal, planPriceJson] = M9_VALUE_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

describe('value goldens', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  useGoldenUpdateCheck(M9_VALUE_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  // Both vendors, so each table covers one fixture source.
  const options = {
    timezone: 'UTC',
    pricingOffline: true,
    plan: ['claude-max-20x', 'chatgpt-plus'],
  } as const;

  it(`freezes ${valueJson}`, async () => {
    const output = await buildValueReportOutput(
      { ...options, plan: [...options.plan], json: true },
      deps,
    );

    await expectGolden(valueJson, output);
  });

  it(`freezes ${valueMarkdown}`, async () => {
    const output = await buildValueReportOutput(
      { ...options, plan: [...options.plan], markdown: true },
      deps,
    );

    await expectGolden(valueMarkdown, output);
  });

  it(`freezes ${valueTerminal}`, async () => {
    const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
    let output: string;

    try {
      output = await buildValueReportOutput({ ...options, plan: [...options.plan] }, deps);
    } finally {
      restoreStdout();
    }

    expect(output).not.toContain('\u001B[');
    await expectGolden(valueTerminal, output);
  });

  it(`freezes ${planPriceJson}`, async () => {
    // Starts mid-March: March is cut by the window, April is idle, June contains today.
    const output = await buildValueReportOutput(
      {
        timezone: 'UTC',
        pricingOffline: true,
        plan: ['claude-pro'],
        planPrice: '18',
        since: '2026-03-10',
        json: true,
      },
      deps,
    );

    await expectGolden(planPriceJson, output);
  });
});
