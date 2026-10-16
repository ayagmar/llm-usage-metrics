// End to end: the payload a --share run embeds, decoded and rolled up by the page's own
// client code, equals the report JSON for the same window and cost mode (invariant 3).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildShareReportData } from '../../src/cli/build-share-report-data.js';
import { buildProjectsReport } from '../../src/cli/run-projects-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
} from '../../src/cli/usage-data-contracts.js';
import {
  createFilters,
  decodeShareReport,
  getCost,
  rollupByDimension,
  rollupByPeriod,
  selectCells,
  sumCells,
  type ShareReport,
  type ShareTotals,
} from '../../src/share-report/client/core/index.js';
import { isPathLike } from '../../src/share-report/redact.js';
import type { ShareCostMode, ShareDateRange } from '../../src/share-report/types.js';
import { roundUsd } from '../../src/utils/usd-math.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  FIXED_NOW,
  WINDOWS_SKIP_REASON,
} from '../golden/golden-harness.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { createCorpusAdapters, generateShareCorpus } from '../helpers/share-payload.js';

const MODES: readonly ShareCostMode[] = ['explicit', 'estimated', 'both'];
const GRANULARITIES = [
  ['daily', 'day'],
  ['weekly', 'week'],
  ['monthly', 'month'],
] as const;

type ReportTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
};

type UsageJsonRow = ReportTotals & { rowType: string; periodKey: string; source: string };

type ProjectJsonRow = ReportTotals & { project: string; events: number };

type Fixture = {
  name: string;
  options: () => ReportCommandOptions;
  deps: () => BuildUsageDataDeps;
  window: ShareDateRange;
  windowOptions: { all: true } | { since: string; until: string };
};

const noEventStore: BuildUsageDataDeps = {
  now: () => FIXED_NOW,
  getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
};

/** What the page shows for a group of cells in one mode, in the report JSON's terms. */
function toReportTotals(report: ShareReport, totals: ShareTotals, mode: ShareCostMode) {
  const cost = getCost(report, totals.costs, mode);

  if (cost.kind !== 'value') {
    throw new Error(`the file holds no ${mode} cost`);
  }

  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens: totals.totalTokens,
    costUsd: cost.costUsd === null ? undefined : roundUsd(cost.costUsd),
    costIncomplete: cost.incompleteEvents > 0 ? true : undefined,
  };
}

function fromReportJson(row: ReportTotals) {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd === undefined ? undefined : roundUsd(row.costUsd),
    costIncomplete: row.costIncomplete === true ? true : undefined,
  };
}

async function reportJson<Data>(
  build: (options: ReportCommandOptions, deps: BuildUsageDataDeps) => Promise<string>,
  fixture: Fixture,
  mode: ShareCostMode,
): Promise<Data> {
  const output = await build(
    { ...fixture.options(), ...fixture.windowOptions, costMode: mode, json: true },
    fixture.deps(),
  );
  return (JSON.parse(output) as { data: Data }).data;
}

function describeClientParity(fixture: Fixture) {
  let report: ShareReport;
  let allCells: number[];

  beforeAll(async () => {
    const data = await buildShareReportData(
      {
        command: 'daily',
        options: fixture.options(),
        window: fixture.window,
        initialView: { ...fixture.window, granularity: 'day' },
      },
      fixture.deps(),
    );
    // Through JSON, as the page reads it.
    const decoded = decodeShareReport(
      JSON.parse(JSON.stringify({ schemaVersion: 1, report: 'share', data })),
    );

    if (!decoded.ok) {
      throw new Error(decoded.error);
    }

    report = decoded.report;
    allCells = selectCells(report, createFilters(fixture.window));
    expect(allCells.length).toBe(report.cellCount);
  });

  describe.each(MODES)(`${fixture.name}, %s costs`, (mode) => {
    it.each(GRANULARITIES)(
      'the page’s %s roll-up by source equals the JSON',
      async (name, granularity) => {
        const rows = await reportJson<UsageJsonRow[]>(
          (options, deps) => buildUsageReport(name, options, deps),
          fixture,
          mode,
        );
        const sourceRows = rows.filter((row) => row.rowType === 'period_source');
        const client = new Map<string, ReturnType<typeof toReportTotals>>();

        report.data.dictionaries.sources.forEach((source, index) => {
          const cells = selectCells(report, { ...createFilters(fixture.window), source: [index] });

          for (const row of rollupByPeriod(report, cells, granularity).rows) {
            client.set(`${row.key} ${source}`, toReportTotals(report, row, mode));
          }
        });

        expect(sourceRows.length).toBeGreaterThan(1);
        expect(client.size).toBe(sourceRows.length);

        for (const row of sourceRows) {
          expect(
            client.get(`${row.periodKey} ${row.source}`),
            `${row.periodKey} ${row.source}`,
          ).toEqual(fromReportJson(row));
        }

        const grandTotals = rows.filter((row) => row.rowType === 'grand_total');
        expect(grandTotals.map(fromReportJson)).toEqual([
          toReportTotals(report, sumCells(report, allCells), mode),
        ]);
      },
    );

    it('the page’s project roll-up equals the projects JSON', async () => {
      const { projects } = await reportJson<{ projects: ProjectJsonRow[] }>(
        buildProjectsReport,
        fixture,
        mode,
      );
      const client = rollupByDimension(report, allCells, 'project');

      expect(client.length).toBe(projects.length);

      for (const row of projects) {
        // The report shows a full path where only it tells projects apart; the file never does.
        if (isPathLike(row.project)) {
          continue;
        }

        const match = client.find((candidate) => candidate.key === row.project);
        expect(match, row.project).toBeDefined();

        if (match) {
          expect(toReportTotals(report, match, mode), row.project).toEqual(fromReportJson(row));
          expect(match.eventCount).toBe(row.events);
        }
      }

      const byTotals = (totals: { totalTokens: number; events: number }[]) =>
        totals.map(({ totalTokens, events }) => [totalTokens, events]).sort();

      expect(
        byTotals(client.map((row) => ({ totalTokens: row.totalTokens, events: row.eventCount }))),
      ).toEqual(byTotals(projects));
    });
  });
}

describe('share page roll-up parity with the report JSON', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const corpus = generateShareCorpus(23, 160);

  describeClientParity({
    name: 'generated corpus',
    options: () => ({ timezone: 'Europe/Paris', pricingOffline: true }),
    deps: () => ({ ...noEventStore, createAdapters: createCorpusAdapters(corpus) }),
    window: { since: '2026-04-01', until: '2026-06-15' },
    windowOptions: { since: '2026-04-01', until: '2026-06-15' },
  });

  describe.skipIf(process.platform === 'win32')(`golden fixture (${WINDOWS_SKIP_REASON})`, () => {
    let sources: ReportCommandOptions;

    beforeAll(async () => {
      sources = {
        ...(await createE2eSourceOptions(environment.rootDir)),
        source: ALL_SOURCE_IDS.join(','),
        timezone: 'UTC',
        pricingOffline: true,
      };
    });

    describeClientParity({
      name: 'golden fixture',
      options: () => sources,
      deps: () => noEventStore,
      window: { since: null, until: null },
      windowOptions: { all: true },
    });
  });
});
