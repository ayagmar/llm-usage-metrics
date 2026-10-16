import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildShareReportData } from '../../src/cli/build-share-report-data.js';
import { buildBlocksReport } from '../../src/cli/run-blocks-report.js';
import { buildProjectsReport } from '../../src/cli/run-projects-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
} from '../../src/cli/usage-data-contracts.js';
import { isPathLike, toShareModelLabel } from '../../src/share-report/redact.js';
import type {
  ShareCostMode,
  ShareDateRange,
  ShareReportData,
} from '../../src/share-report/types.js';
import { roundUsd } from '../../src/utils/usd-math.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  FIXED_NOW,
  WINDOWS_SKIP_REASON,
} from '../golden/golden-harness.js';
import {
  createCorpusAdapters,
  generateShareCorpus,
  rollUpCube,
  toReportPeriodKey,
  type RolledUpTotals,
} from '../helpers/share-payload.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const MODES: readonly ShareCostMode[] = ['explicit', 'estimated', 'both'];
const GRANULARITIES = ['daily', 'weekly', 'monthly'] as const;

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
  /** Report options for the same window. */
  windowOptions: { all: true } | { since: string; until: string };
};

const noEventStore: BuildUsageDataDeps = {
  now: () => FIXED_NOW,
  getEventStoreRuntimeConfig: () => ({ enabled: false, path: '', disabledBy: 'configuration' }),
};

function expectTotals(rolled: RolledUpTotals | undefined, row: ReportTotals, label: string): void {
  expect(rolled, label).toBeDefined();
  expect(
    {
      inputTokens: rolled?.inputTokens,
      outputTokens: rolled?.outputTokens,
      reasoningTokens: rolled?.reasoningTokens,
      cacheReadTokens: rolled?.cacheReadTokens,
      cacheWriteTokens: rolled?.cacheWriteTokens,
      totalTokens: rolled?.totalTokens,
      costUsd: rolled?.costUsd === undefined ? undefined : roundUsd(rolled.costUsd),
      costIncomplete: rolled?.costIncomplete === true ? true : undefined,
    },
    label,
  ).toEqual({
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd === undefined ? undefined : roundUsd(row.costUsd),
    costIncomplete: row.costIncomplete === true ? true : undefined,
  });
}

/** The file for the command run in `commandMode` (the default `both` when undefined). */
async function buildShare(
  fixture: Fixture,
  commandMode: ShareCostMode | undefined,
  extra: ReportCommandOptions = {},
) {
  return buildShareReportData(
    {
      command: 'daily',
      options: { ...fixture.options(), costMode: commandMode, ...extra },
      window: fixture.window,
      initialView: { ...fixture.window, granularity: 'day' },
    },
    fixture.deps(),
  );
}

async function reportJson<Data>(
  build: (options: ReportCommandOptions, deps: BuildUsageDataDeps) => Promise<string>,
  fixture: Fixture,
  mode: ShareCostMode,
  extra: ReportCommandOptions = {},
): Promise<Data> {
  const output = await build(
    { ...fixture.options(), ...fixture.windowOptions, costMode: mode, json: true, ...extra },
    fixture.deps(),
  );
  return (JSON.parse(output) as { data: Data }).data;
}

function expectUsageParity(data: ShareReportData, rows: UsageJsonRow[], mode: ShareCostMode) {
  return (granularity: (typeof GRANULARITIES)[number]) => {
    const { periods, sources } = data.dictionaries;
    const rolled = rollUpCube(
      data,
      mode,
      (cell) =>
        `${toReportPeriodKey(periods[data.cube.period[cell]], granularity)}\0${sources[data.cube.source[cell]]}`,
    );
    const total = rollUpCube(data, mode, () => 'ALL').get('ALL');
    const sourceRows = rows.filter((row) => row.rowType === 'period_source');

    expect(sourceRows.length).toBe(rolled.size);

    for (const row of sourceRows) {
      expectTotals(
        rolled.get(`${row.periodKey}\0${row.source}`),
        row,
        `${granularity} ${row.periodKey} ${row.source}`,
      );
    }

    const grandTotal = rows.find((row) => row.rowType === 'grand_total');

    if (grandTotal && sourceRows.length > 0) {
      expectTotals(total, grandTotal, `${granularity} total`);
    }
  };
}

function describeParity(fixture: Fixture) {
  let data: ShareReportData;

  beforeAll(async () => {
    // One file holds every mode, whichever mode the command ran in.
    data = await buildShare(fixture, undefined);
  });

  it.each(['explicit', 'estimated'] as const)(
    `${fixture.name}: a run in %s mode differs only in meta.costMode`,
    async (commandMode) => {
      const other = await buildShare(fixture, commandMode);

      expect(other.meta.costMode).toBe(commandMode);
      expect({ ...other, meta: { ...other.meta, costMode: 'both' } }).toEqual(data);
    },
  );

  describe.each(MODES)(`${fixture.name}, %s costs`, (mode) => {
    it.each(GRANULARITIES)('rolls up to the %s JSON', async (granularity) => {
      const rows = await reportJson<UsageJsonRow[]>(
        (options, deps) => buildUsageReport(granularity, options, deps),
        fixture,
        mode,
      );

      expect(rows.length).toBeGreaterThan(1);
      expectUsageParity(data, rows, mode)(granularity);
    });

    it('rolls up to the projects JSON', async () => {
      const projects = await reportJson<{ projects: ProjectJsonRow[] }>(
        buildProjectsReport,
        fixture,
        mode,
      );
      const labels = data.dictionaries.projects;
      const rolled = rollUpCube(data, mode, (cell) => labels[data.cube.project[cell]]);

      expect(projects.projects.length).toBe(rolled.size);

      for (const row of projects.projects) {
        // The report shows a full path where only it tells projects apart; the file never does.
        if (isPathLike(row.project)) {
          expect(labels).not.toContain(row.project);
          continue;
        }

        expectTotals(rolled.get(row.project), row, `project ${row.project}`);
        expect(rolled.get(row.project)?.events).toBe(row.events);
      }

      // Every project, numbered ones included, by its totals.
      const byTotals = (totals: { totalTokens: number; events: number }[]) =>
        totals.map(({ totalTokens, events }) => [totalTokens, events]).sort();

      expect(byTotals([...rolled.values()])).toEqual(byTotals(projects.projects));
    });
  });
}

type BlockJsonRow = ReportTotals & {
  source: string;
  start: string;
  end: string;
  startUncertain: boolean;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
  models: string[];
};

async function expectBlocksParity(
  fixture: Fixture,
  mode: ShareCostMode,
  extra: ReportCommandOptions = {},
) {
  const data = await buildShare(fixture, undefined, extra);
  const blocks = await reportJson<{ blocks: BlockJsonRow[] }>(
    buildBlocksReport,
    fixture,
    mode,
    extra,
  );
  const { sources, models } = data.dictionaries;

  expect(blocks.blocks.length).toBeGreaterThan(0);
  expect(
    data.blocks.rows.map((row) => ({
      ...row,
      source: sources[row.source],
      models: row.models.map((model) => models[model]),
      cost: row.costs[mode],
    })),
  ).toEqual(
    blocks.blocks.map((row) => ({
      source: row.source,
      start: row.start,
      end: row.end,
      startUncertain: row.startUncertain,
      firstEventAt: row.firstEventAt,
      lastEventAt: row.lastEventAt,
      eventCount: row.eventCount,
      models: [...new Set(row.models.map(toShareModelLabel))],
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
      costs: expect.any(Object) as unknown,
      cost: {
        costUsd: row.costUsd ?? null,
        incompleteEvents: expect.any(Number) as unknown,
      },
    })),
  );

  for (const [index, row] of data.blocks.rows.entries()) {
    expect((row.costs[mode]?.incompleteEvents ?? 0) > 0).toBe(
      blocks.blocks[index].costIncomplete === true,
    );
  }
}

describe('share payload parity with the report JSON', () => {
  const environment = useIsolatedEnvironment();
  useBundledPricingOnly();

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const corpus = generateShareCorpus(11, 160);
  const corpusFixture: Fixture = {
    name: 'generated corpus',
    options: () => ({ timezone: 'Europe/Paris', pricingOffline: true }),
    deps: () => ({ ...noEventStore, createAdapters: createCorpusAdapters(corpus) }),
    window: { since: '2026-04-01', until: '2026-06-15' },
    windowOptions: { since: '2026-04-01', until: '2026-06-15' },
  };

  describeParity(corpusFixture);

  it.each(MODES)('places and costs blocks as blocks --json does (--cost-mode %s)', async (mode) => {
    await expectBlocksParity(corpusFixture, mode);
  });

  it('keeps the account’s blocks under --model, as blocks --json does', async () => {
    await expectBlocksParity(corpusFixture, 'both', { model: ['gpt-5'] });
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

    describeParity({
      name: 'golden fixture',
      options: () => sources,
      deps: () => noEventStore,
      window: { since: null, until: null },
      windowOptions: { all: true },
    });
  });
});
