import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContextReport } from '../../src/cli/run-context-report.js';
import type { ContextCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import { expectGolden, freezeDate, useGoldenUpdateCheck } from './golden-harness.js';
import { createContextFixtureAdapters } from './m12-context-fixture.js';
import { M12_CONTEXT_GOLDEN_NAMES } from './m12-context-names.js';

const [
  contextJson,
  contextMarkdown,
  contextTerminal,
  bySessionJson,
  bySessionTerminal,
  allJson,
  narrowTerminal,
  bySessionNarrowTerminal,
  emptyTerminal,
] = M12_CONTEXT_GOLDEN_NAMES;

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

describe('context goldens', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  useGoldenUpdateCheck(M12_CONTEXT_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createContextFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true } as const;

  async function renderTerminal(extra: ContextCommandOptions, columns = TERMINAL_COLUMNS) {
    const restoreStdout = overrideStdoutTty(columns);

    try {
      return await buildContextReport({ ...options, ...extra }, deps);
    } finally {
      restoreStdout();
    }
  }

  it.each([
    [contextJson, { json: true }],
    [contextMarkdown, { markdown: true }],
    [bySessionJson, { bySession: true, json: true }],
    [allJson, { all: true, json: true }],
  ] as const)('freezes %s', async (name, extra) => {
    await expectGolden(name, await buildContextReport({ ...options, ...extra }, deps));
  });

  it.each([
    [contextTerminal, {}, TERMINAL_COLUMNS],
    [bySessionTerminal, { bySession: true }, TERMINAL_COLUMNS],
    [narrowTerminal, {}, 60],
    [bySessionNarrowTerminal, { bySession: true }, 80],
    [emptyTerminal, { repo: 'no-such-project' }, TERMINAL_COLUMNS],
  ] as const)('freezes %s', async (name, extra, columns) => {
    const output = await renderTerminal(extra, columns);

    expect(output).not.toContain('\u001B[');
    await expectGolden(name, output);
  });
});
