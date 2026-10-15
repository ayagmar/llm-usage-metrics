import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProjectsReport } from '../../src/cli/run-projects-report.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, freezeDate, useGoldenUpdateCheck } from './golden-harness.js';
import { M9_PROJECTS_GOLDEN_NAMES } from './m9-projects-names.js';
import { createProjectFixtureAdapters } from './m9-project-fixture.js';

const [json, markdown, terminal, monthlyJson, repoFilterJson] = M9_PROJECTS_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

describe('projects goldens', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  useGoldenUpdateCheck(M9_PROJECTS_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true } as const;

  it(`freezes ${json}`, async () => {
    await expectGolden(json, await buildProjectsReport({ ...options, json: true }, deps));
  });

  it(`freezes ${markdown}`, async () => {
    await expectGolden(markdown, await buildProjectsReport({ ...options, markdown: true }, deps));
  });

  it(`freezes ${terminal}`, async () => {
    const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
    let output: string;

    try {
      output = await buildProjectsReport(options, deps);
    } finally {
      restoreStdout();
    }

    expect(output).not.toContain('\u001B[');
    await expectGolden(terminal, output);
  });

  it(`freezes ${monthlyJson}`, async () => {
    const output = await buildProjectsReport(
      { ...options, granularity: 'monthly', json: true },
      deps,
    );

    await expectGolden(monthlyJson, output);
  });

  it(`freezes ${repoFilterJson}`, async () => {
    const output = await buildProjectsReport({ ...options, repo: ['api'], json: true }, deps);

    await expectGolden(repoFilterJson, output);
  });
});
