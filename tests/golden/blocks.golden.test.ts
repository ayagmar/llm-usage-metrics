import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runBlocksReport } from '../../src/cli/run-blocks-report.js';
import type { BlocksCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { overrideStdoutTty } from '../helpers/stdout.js';
import {
  captureStdout,
  expectGolden,
  fixedNow,
  freezeDate,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';
import { M9_BLOCKS_GOLDEN_NAMES } from './m9-blocks-names.js';
import { PROJECT_FIXTURE_EVENTS, PROJECT_FIXTURE_FILES } from './m9-project-fixture.js';

/** Fixed width for terminal goldens; colour is off through NO_COLOR. */
const TERMINAL_COLUMNS = 120;

/**
 * Added to the project fixture: a claude block from 22:00 on 2026-06-20 across midnight,
 * and blocks of both sources that contain FIXED_NOW (2026-06-21 12:00 UTC), codex's from
 * two machines.
 */
const EXTRA_EVENTS: readonly UsageEvent[] = [
  createUsageEvent({
    source: 'claude',
    sessionId: 'claude-late',
    timestamp: '2026-06-20T22:30:00.000Z',
    repoRoot: '/w/a/api',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 2_200,
    outputTokens: 400,
  }),
  createUsageEvent({
    source: 'claude',
    sessionId: 'claude-late',
    timestamp: '2026-06-21T01:40:00.000Z',
    repoRoot: '/w/a/api',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 1_000,
    outputTokens: 250,
  }),
  createUsageEvent({
    source: 'claude',
    sessionId: 'claude-now',
    timestamp: '2026-06-21T10:15:00.000Z',
    repoRoot: '/w/b/api',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 5_000,
    outputTokens: 1_200,
    cacheReadTokens: 20_000,
  }),
  {
    ...createUsageEvent({
      source: 'codex',
      sessionId: 'codex-now',
      timestamp: '2026-06-21T10:50:00.000Z',
      repoRoot: '/w/c/tools',
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 3_000,
      outputTokens: 500,
    }),
    machine: 'laptop',
  },
  createUsageEvent({
    source: 'codex',
    sessionId: 'codex-now',
    timestamp: '2026-06-21T11:20:00.000Z',
    repoRoot: '/w/c/tools',
    provider: 'openai',
    model: 'gpt-5',
    inputTokens: 1_500,
    outputTokens: 300,
  }),
];

const BLOCKS_EVENTS: readonly UsageEvent[] = [...PROJECT_FIXTURE_EVENTS, ...EXTRA_EVENTS];

function createBlocksFixtureAdapters(): SourceAdapter[] {
  return (['claude', 'codex'] as const).map((source) => ({
    id: source,
    discoverFiles: async () => [PROJECT_FIXTURE_FILES[source]],
    read: readFrom(async () => BLOCKS_EVENTS.filter((event) => event.source === source)),
  }));
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`blocks goldens (${WINDOWS_SKIP_REASON})`, () => {
  useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();
  useGoldenUpdateCheck(M9_BLOCKS_GOLDEN_NAMES);

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  function renderBlocks(options: BlocksCommandOptions): Promise<string> {
    return captureStdout(() =>
      runBlocksReport(
        { timezone: 'UTC', pricingOffline: true, ...options },
        {
          now: fixedNow,
          createAdapters: createBlocksFixtureAdapters,
          getEventStoreRuntimeConfig: () => ({
            enabled: false,
            path: '',
            disabledBy: 'configuration',
          }),
        },
      ),
    );
  }

  it('freezes reports/blocks.json', async () => {
    await expectGolden('reports/blocks.json', await renderBlocks({ json: true }));
  });

  it('freezes reports/blocks.md', async () => {
    await expectGolden('reports/blocks.md', await renderBlocks({ markdown: true }));
  });

  it('freezes reports/blocks.txt', async () => {
    const restoreStdout = overrideStdoutTty(TERMINAL_COLUMNS);
    let output: string;

    try {
      output = await renderBlocks({});
    } finally {
      restoreStdout();
    }

    expect(output).not.toContain('\u001B[');
    await expectGolden('reports/blocks.txt', output);
  });

  it('freezes reports/blocks-top-3.json', async () => {
    await expectGolden('reports/blocks-top-3.json', await renderBlocks({ json: true, top: '3' }));
  });

  it('never reaches the network', () => {
    expect(pricing.fetch).not.toHaveBeenCalled();
  });
});
