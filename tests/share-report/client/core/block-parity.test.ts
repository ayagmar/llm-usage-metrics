import { describe, expect, it } from 'vitest';

import { buildShareReportData } from '../../../../src/cli/build-share-report-data.js';
import { buildBlocksReport } from '../../../../src/cli/run-blocks-report.js';
import type { BuildUsageDataDeps } from '../../../../src/cli/usage-data-contracts.js';
import { createUsageEvent, type UsageEvent } from '../../../../src/domain/usage-event.js';
import {
  buildBlockMatrix,
  createFilters,
  decodeShareReport,
} from '../../../../src/share-report/client/core/index.js';
import type { ShareDateRange } from '../../../../src/share-report/types.js';
import { useIsolatedEnvironment } from '../../../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../../../helpers/offline-pricing.js';
import { createCorpusAdapters } from '../../../helpers/share-payload.js';

useIsolatedEnvironment();
useBundledPricingOnly();

const event = (timestamp: string): UsageEvent =>
  createUsageEvent({
    source: 'claude',
    sessionId: 'session-1',
    timestamp,
    repoRoot: '/srv/project-a',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
  });

const deps = (events: UsageEvent[]): BuildUsageDataDeps => ({
  now: () => new Date('2026-06-21T12:00:00Z'),
  createAdapters: createCorpusAdapters(events),
  getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
});

// One block runs from 14 Jun 23:00 into 15 Jun; another starts on 15 Jun; one ends at
// midnight before the 16th.
const EVENTS = [
  event('2026-06-14T23:30:00Z'),
  event('2026-06-15T00:30:00Z'),
  event('2026-06-15T10:00:00Z'),
  event('2026-06-15T19:30:00Z'),
];

async function pageBlocks(window: ShareDateRange, view: ShareDateRange) {
  const data = await buildShareReportData(
    {
      command: 'daily',
      options: { timezone: 'UTC', cost: false, sync: false },
      window,
      initialView: { ...window, granularity: 'day' },
    },
    deps(EVENTS),
  );
  const decoded = decodeShareReport({ schemaVersion: 1, report: 'share', data });

  if (!decoded.ok) {
    throw new Error(decoded.error);
  }

  const matrix = buildBlockMatrix(
    decoded.report,
    createFilters(view),
    { first: view.since ?? '', last: view.until ?? '' },
    { kind: 'tokens' },
  );
  const starts = matrix.days.flatMap((day, row) =>
    matrix.counts[row].flatMap((count, hour) =>
      count === 0 ? [] : [`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`],
    ),
  );

  return { starts, tokens: matrix.values.flat().reduce((sum, value) => sum + value, 0) };
}

async function cliBlocks(range: { since: string; until: string }) {
  const output = await buildBlocksReport(
    { ...range, timezone: 'UTC', sync: false, pricingOffline: true, json: true },
    deps(EVENTS),
  );
  const blocks = (
    JSON.parse(output) as { data: { blocks: { start: string; totalTokens: number }[] } }
  ).data.blocks;

  return {
    starts: blocks.map((block) => block.start).sort(),
    tokens: blocks.reduce((sum, block) => sum + block.totalTokens, 0),
  };
}

describe('the page blocks against blocks --json', () => {
  it('keeps a block that started the day before the window and runs into it', async () => {
    const day = { since: '2026-06-15', until: '2026-06-15' };

    expect(await pageBlocks(day, day)).toEqual(await cliBlocks(day));
  });

  it('keeps a block that started before a narrowed view and runs into it', async () => {
    const window = { since: '2026-06-14', until: '2026-06-16' };
    const view = { since: '2026-06-15', until: '2026-06-15' };
    const page = await pageBlocks(window, view);

    expect(page.starts).toEqual((await cliBlocks(view)).starts);
    expect(page.starts[0]).toBe('2026-06-14T23:00:00.000Z');
  });

  it('leaves out a block that ends at the start of the view', async () => {
    const window = { since: '2026-06-14', until: '2026-06-16' };
    const view = { since: '2026-06-16', until: '2026-06-16' };

    expect(await pageBlocks(window, view)).toEqual(await cliBlocks(view));
    expect((await pageBlocks(window, view)).starts).toEqual([]);
  });
});
