// End to end: the payload a --share run embeds, decoded and rolled up by the page's own
// client code, equals the report JSON for the same window and cost mode (invariant 3).

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildShareReportData } from '../../src/cli/build-share-report-data.js';
import { buildEfficiencyReport, runEfficiencyReport } from '../../src/cli/run-efficiency-report.js';
import { buildProjectsReport } from '../../src/cli/run-projects-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import * as shareArtifact from '../../src/cli/share-artifact.js';
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
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { roundUsd } from '../../src/utils/usd-math.js';
import {
  ALL_SOURCE_IDS,
  createE2eSourceOptions,
  FIXED_NOW,
  WINDOWS_SKIP_REASON,
} from '../golden/golden-harness.js';
import { createGitFixtureRepo, isolatedGitEnv } from '../helpers/git-fixtures.js';
import { readSharePayload } from '../helpers/share-html.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import { createCorpusAdapters, generateShareCorpus } from '../helpers/share-payload.js';

const MODES: readonly ShareCostMode[] = ['explicit', 'estimated', 'both'];
const GRANULARITIES = [
  ['daily', 'day'],
  ['weekly', 'week'],
  ['monthly', 'month'],
] as const;
// The hourly report is for short windows, so it is checked on the narrowed period only.
const SUB_WINDOW_GRANULARITIES = [...GRANULARITIES, ['hourly', 'hour']] as const;

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
  /** A period the page narrows to inside the window. */
  subWindow?: { since: string; until: string };
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
  windowOptions: Fixture['windowOptions'] = fixture.windowOptions,
): Promise<Data> {
  const output = await build(
    { ...fixture.options(), ...windowOptions, costMode: mode, json: true },
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

  /** The page's roll-up by period and source over `range` equals the report JSON for it. */
  async function expectSourceRollupParity(
    name: (typeof SUB_WINDOW_GRANULARITIES)[number][0],
    granularity: (typeof SUB_WINDOW_GRANULARITIES)[number][1],
    mode: ShareCostMode,
    range: ShareDateRange,
    windowOptions: Fixture['windowOptions'],
  ) {
    const rows = await reportJson<UsageJsonRow[]>(
      (options, deps) => buildUsageReport(name, options, deps),
      fixture,
      mode,
      windowOptions,
    );
    const sourceRows = rows.filter((row) => row.rowType === 'period_source');
    const client = new Map<string, ReturnType<typeof toReportTotals>>();

    report.data.dictionaries.sources.forEach((source, index) => {
      const cells = selectCells(report, { ...createFilters(range), source: [index] });

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
      toReportTotals(report, sumCells(report, selectCells(report, createFilters(range))), mode),
    ]);
  }

  describe.each(MODES)(`${fixture.name}, %s costs`, (mode) => {
    it.each(GRANULARITIES)(
      'the page’s %s roll-up by source equals the JSON',
      async (name, granularity) => {
        await expectSourceRollupParity(
          name,
          granularity,
          mode,
          fixture.window,
          fixture.windowOptions,
        );
      },
    );

    const { subWindow } = fixture;

    if (subWindow) {
      it.each(SUB_WINDOW_GRANULARITIES)(
        `narrowed to ${subWindow.since}..${subWindow.until}, the page’s %s roll-up by source equals the JSON`,
        async (name, granularity) => {
          await expectSourceRollupParity(name, granularity, mode, subWindow, subWindow);
        },
      );
    }

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

  // Paris moves its clocks forward on 2026-03-29.
  describeClientParity({
    name: 'generated corpus',
    options: () => ({ timezone: 'Europe/Paris', pricingOffline: true }),
    deps: () => ({ ...noEventStore, createAdapters: createCorpusAdapters(corpus) }),
    window: { since: '2026-03-15', until: '2026-06-15' },
    windowOptions: { since: '2026-03-15', until: '2026-06-15' },
    subWindow: { since: '2026-03-22', until: '2026-04-05' },
  });

  // Sydney moves its clocks back on 2026-04-05: 02:00–03:00 local happens twice, here once
  // in each offset.
  const fallBackCorpus = [
    ...corpus,
    ...['2026-04-04T15:30:00.000Z', '2026-04-04T16:30:00.000Z'].map((timestamp, index) =>
      createUsageEvent({
        source: index === 0 ? 'claude' : 'codex',
        sessionId: `fall-back-${String(index)}`,
        timestamp,
        model: index === 0 ? 'claude-sonnet-4-5' : 'gpt-5',
        inputTokens: 1_000,
        outputTokens: 100,
      }),
    ),
  ];
  describeClientParity({
    name: 'generated corpus in Australia/Sydney',
    options: () => ({ timezone: 'Australia/Sydney', pricingOffline: true }),
    deps: () => ({ ...noEventStore, createAdapters: createCorpusAdapters(fallBackCorpus) }),
    window: { since: '2026-03-01', until: '2026-06-20' },
    windowOptions: { since: '2026-03-01', until: '2026-06-20' },
    subWindow: { since: '2026-03-30', until: '2026-04-12' },
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

/** One Claude assistant row in `cwd` with `tokens` input tokens and no output. */
function claudeRow(id: string, timestamp: string, cwd: string, tokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId: `efficiency-scope-${id}`,
    cwd,
    uuid: `efficiency-scope-row-${id}`,
    message: {
      id: `efficiency-scope-msg-${id}`,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: tokens, output_tokens: 0 },
    },
  });
}

describe.skipIf(process.platform === 'win32')(
  `efficiency share scope (${WINDOWS_SKIP_REASON})`,
  () => {
    const environment = useIsolatedEnvironment();
    useBundledPricingOnly();

    it('holds only the usage the report counts: its repository, in periods with commits', async () => {
      const { rootDir } = environment;
      const repoA = await createGitFixtureRepo(path.join(rootDir, 'a'), [
        { date: '2026-06-12T09:00:00Z', message: 'feat: a', files: { 'a.txt': 'a\n' } },
      ]);
      const repoB = await createGitFixtureRepo(path.join(rootDir, 'b'), [
        { date: '2026-06-12T09:00:00Z', message: 'feat: b', files: { 'b.txt': 'b\n' } },
      ]);
      for (const [name, value] of Object.entries(isolatedGitEnv(repoA.globalConfigPath))) {
        vi.stubEnv(name, value);
      }

      const claudeDir = path.join(rootDir, 'claude');
      await mkdir(path.join(claudeDir, 'p'), { recursive: true });
      await writeFile(
        path.join(claudeDir, 'p', 'session.jsonl'),
        [
          // Counted: repo A in June, which has a commit.
          claudeRow('a-june', '2026-06-12T10:00:00.000Z', repoA.repoDir, 110),
          // Another repository, and repo A in May, which has no commit.
          claudeRow('b-june', '2026-06-12T11:00:00.000Z', repoB.repoDir, 220),
          claudeRow('a-may', '2026-05-12T10:00:00.000Z', repoA.repoDir, 330),
        ].join('\n') + '\n',
      );

      const options = {
        claudeDir,
        source: 'claude',
        timezone: 'UTC',
        since: '2026-05-01',
        until: '2026-06-30',
        repoDir: repoA.repoDir,
        pricingOffline: true,
        sync: false,
      };
      const json = JSON.parse(
        await buildEfficiencyReport('monthly', { ...options, json: true }),
      ) as {
        data: { rows: { rowType: string; periodKey: string; totalTokens: number }[] };
      };

      const cwd = await mkdtemp(path.join(rootDir, 'cwd-'));
      const previousCwd = process.cwd();
      vi.spyOn(shareArtifact, 'openShareFile').mockResolvedValue();
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      process.chdir(cwd);

      try {
        await runEfficiencyReport('monthly', { ...options, share: true });
      } finally {
        process.chdir(previousCwd);
        vi.restoreAllMocks();
      }

      const html = await readFile(path.join(cwd, 'efficiency-monthly-share.html'), 'utf8');
      const decoded = decodeShareReport(readSharePayload(html));

      if (!decoded.ok) {
        throw new Error(decoded.error);
      }

      const { report } = decoded;
      const window = { since: options.since, until: options.until };
      const cells = selectCells(report, createFilters(window));
      const months = rollupByPeriod(report, cells, 'month').rows.map((row) => [
        row.key,
        row.totalTokens,
      ]);

      expect(
        json.data.rows
          .filter((row) => row.rowType === 'period')
          .map((row) => [row.periodKey, row.totalTokens]),
      ).toEqual([['2026-06', 110]]);
      expect(months).toEqual([['2026-06', 110]]);
      expect(sumCells(report, cells).eventCount).toBe(1);
      expect(report.data.dictionaries.projects).toHaveLength(1);
      expect(report.data.sessions.rows.map((session) => session.eventCount)).toEqual([1]);
      expect(report.data.blocks.rows.map((block) => block.totalTokens)).toEqual([110]);
    });
  },
);
