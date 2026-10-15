import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { describe, expect, it } from 'vitest';

import { buildCompareData } from '../../src/cli/build-compare-data.js';
import { buildTrendsData } from '../../src/cli/build-trends-data.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { renderCompareReport } from '../../src/render/render-compare-report.js';
import { renderTrendsReport } from '../../src/render/render-trends-report.js';
import type { TrendSeries } from '../../src/trends/trends-series.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { readFrom } from '../helpers/fake-read.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const options = { timezone: 'UTC', pricingOffline: true } as const;
const fixtureDeps = { createAdapters: createProjectFixtureAdapters };
const ROOTS = ['/w/a/api', '/w/b/api', '/w/b/api/', '/x/web', 'C:\\x\\web', undefined] as const;
const MODELS = ['gpt-5', 'gpt-4.1', 'unpriced-model'] as const;

function adaptersFor(events: UsageEvent[]): () => SourceAdapter[] {
  const sources = [...new Set(events.map((event) => event.source))];

  return () =>
    sources.map((source) => ({
      id: source,
      discoverFiles: async () => [`/generated/${source}.jsonl`],
      read: readFrom(async () => events.filter((event) => event.source === source)),
    }));
}

/** Deterministic pseudo-random events over 2026-06-01..10, several roots, some unpriced. */
function generateEvents(seed: number, count: number): UsageEvent[] {
  let state = seed;
  const next = (bound: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };

  return Array.from({ length: count }, (_, index) => {
    const day = String(1 + next(10)).padStart(2, '0');
    const hour = String(next(24)).padStart(2, '0');
    const minute = String(next(60)).padStart(2, '0');

    return createUsageEvent({
      source: next(2) === 0 ? 'codex' : 'pi',
      sessionId: `session-${next(4)}`,
      timestamp: `2026-06-${day}T${hour}:${minute}:00.000Z`,
      repoRoot: ROOTS[next(ROOTS.length)],
      provider: 'openai',
      model: MODELS[next(MODELS.length)],
      inputTokens: 100 + next(5_000) + index,
      outputTokens: next(2_000),
      cacheReadTokens: next(3_000),
    });
  });
}

function markdownCells(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function seriesValuesByDate(series: Pick<TrendSeries, 'buckets'>): Map<string, number> {
  return new Map(series.buckets.map((bucket) => [bucket.date, bucket.value]));
}

describe('trends --by-repo', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  for (const metric of ['cost', 'tokens'] as const) {
    it(`sums the per-project ${metric} series to the combined series on every day`, async () => {
      for (const seed of [1, 7, 42, 2026]) {
        const events = generateEvents(seed, 60);
        const data = await buildTrendsData(
          { ...options, since: '2026-05-30', until: '2026-06-12', metric, byRepo: true },
          { createAdapters: adaptersFor(events) },
        );
        const projectSeries = data.projectSeries ?? [];

        expect(projectSeries.length).toBeGreaterThan(1);

        for (const bucket of data.totalSeries.buckets) {
          const projectSum = projectSeries.reduce(
            (sum, series) => sum + (seriesValuesByDate(series).get(bucket.date) ?? 0),
            0,
          );
          const projectIncomplete = projectSeries.some(
            (series) =>
              series.buckets.find((projectBucket) => projectBucket.date === bucket.date)
                ?.incomplete === true,
          );

          expect(projectSum).toBeCloseTo(bucket.value, 9);
          expect(projectIncomplete).toBe(bucket.incomplete === true);
        }

        expect(new Set(projectSeries.map((series) => series.project)).size).toBe(
          projectSeries.length,
        );
      }
    });
  }

  it('gives each project one series under one label, by total then label', async () => {
    const data = await buildTrendsData(
      { ...options, since: '2026-05-01', until: '2026-06-30', metric: 'tokens', byRepo: true },
      fixtureDeps,
    );
    const projectSeries = data.projectSeries ?? [];

    expect(projectSeries.map((series) => [series.project, series.repoRoot])).toEqual([
      ['a/api', '/w/a/api'],
      ['b/api', '/w/b/api'],
      ['web', 'C:\\src\\web'],
      ['(unattributed)', null],
      ['src', '/w/a/api/src'],
      ['tools', '/w/c/tools'],
    ]);
    expect(projectSeries[0].summary.total).toBe(17_900);
    expect(projectSeries[0].summary.observedDayCount).toBe(2);
    expect(data.sourceSeries).toBeUndefined();
  });

  it('labels from the charted range only, so a later collision does not lengthen labels', async () => {
    const data = await buildTrendsData(
      { ...options, until: '2026-05-31', metric: 'tokens', byRepo: true },
      fixtureDeps,
    );

    expect(data.projectSeries?.map((series) => series.project)).toEqual(['api', 'web']);
  });

  it('splits active time by project, a session moving between projects counting in each', async () => {
    const events = [
      { repoRoot: '/w/one', timestamp: '2026-06-01T10:00:00.000Z' },
      { repoRoot: '/w/one', timestamp: '2026-06-01T10:03:00.000Z' },
      { repoRoot: '/w/two', timestamp: '2026-06-01T10:06:00.000Z' },
      { repoRoot: '/w/two', timestamp: '2026-06-01T10:08:00.000Z' },
    ].map((input) =>
      createUsageEvent({
        source: 'codex',
        sessionId: 'shared',
        provider: 'openai',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 1,
        ...input,
      }),
    );
    const data = await buildTrendsData(
      {
        ...options,
        since: '2026-06-01',
        until: '2026-06-01',
        metric: 'active-hours',
        byRepo: true,
      },
      { createAdapters: adaptersFor(events) },
    );

    expect(data.projectSeries?.map((series) => [series.project, series.summary.total])).toEqual([
      ['one', 3 * 60_000],
      ['two', 2 * 60_000],
    ]);
    // The combined series keeps the session whole, so it also counts the 3 min switch.
    expect(data.totalSeries.summary.total).toBe(8 * 60_000);
  });

  it('keeps only the projects --repo selects', async () => {
    const data = await buildTrendsData(
      {
        ...options,
        since: '2026-06-15',
        until: '2026-06-15',
        metric: 'tokens',
        byRepo: true,
        repo: 'api',
      },
      fixtureDeps,
    );

    expect(data.projectSeries?.map((series) => series.repoRoot)).toEqual(['/w/a/api', '/w/b/api']);
    expect(data.totalSeries.summary.total).toBe(
      (data.projectSeries ?? []).reduce((sum, series) => sum + series.summary.total, 0),
    );
  });

  it('has no project series, and draws the empty summary, when the range has no usage', async () => {
    const data = await buildTrendsData(
      { ...options, since: '2026-01-01', until: '2026-01-03', byRepo: true },
      fixtureDeps,
    );

    expect(data.projectSeries).toEqual([]);
    expect(renderTrendsReport(data, 'terminal', { useColor: false })).toContain(
      'No usage data found for the selected date range.',
    );
  });

  it('rejects --by-repo with --by-source before reading any source', async () => {
    let created = false;

    await expect(
      buildTrendsData(
        { ...options, byRepo: true, bySource: true },
        {
          createAdapters: () => {
            created = true;
            return [];
          },
        },
      ),
    ).rejects.toThrow('--by-repo cannot be combined with --by-source');
    expect(created).toBe(false);
  });

  it('leaves projectSeries out without --by-repo', async () => {
    const data = await buildTrendsData(
      { ...options, since: '2026-06-15', until: '2026-06-15' },
      fixtureDeps,
    );

    expect(data.projectSeries).toBeUndefined();
    expect(
      (JSON.parse(renderTrendsReport(data, 'json')) as { data: object }).data,
    ).not.toHaveProperty('projectSeries');
  });

  it('draws one row per project in the terminal and one column per project in markdown', async () => {
    const data = await buildTrendsData(
      { ...options, since: '2026-06-14', until: '2026-06-16', metric: 'tokens', byRepo: true },
      fixtureDeps,
    );
    const terminal = renderTrendsReport(data, 'terminal', { useColor: false, terminalWidth: 80 });
    const markdown = renderTrendsReport(data, 'markdown');

    expect(terminal).toContain('Daily Token Usage Trend by Project (3 days)');
    expect(
      terminal
        .split('\n')
        .find((line) => line.startsWith('(unattributed)'))
        ?.trimEnd(),
    ).toMatch(/1\.8K$/u);
    const lines = markdown.split('\n');

    expect(markdownCells(lines[0])).toEqual([
      'Date',
      'combined',
      'a/api',
      'b/api',
      'web',
      '\\(unattributed\\)',
      'src',
      'tools',
    ]);
    expect(markdownCells(lines.at(-1) ?? '')).toEqual([
      'Total',
      '33,740',
      '16,400',
      '11,700',
      '2,100',
      '1,750',
      '1,000',
      '790',
    ]);
  });
});

describe('compare --by-repo', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  const windows = {
    since: '2026-06-06',
    until: '2026-06-10',
    vsSince: '2026-06-01',
    vsUntil: '2026-06-05',
  } as const;

  it('gives per-project deltas of current minus baseline that add up to the window totals', async () => {
    for (const seed of [3, 11, 99]) {
      const data = await buildCompareData(
        { ...options, ...windows, byRepo: true },
        { createAdapters: adaptersFor(generateEvents(seed, 80)) },
      );
      const projects = data.projects ?? [];

      expect(projects.length).toBeGreaterThan(1);

      for (const side of ['current', 'baseline'] as const) {
        const totals = data[side].totals;

        for (const key of ['inputTokens', 'totalTokens', 'events'] as const) {
          expect(projects.reduce((sum, row) => sum + row[side][key], 0)).toBe(totals[key]);
        }

        expect(projects.reduce((sum, row) => sum + (row[side].costUsd ?? 0), 0)).toBeCloseTo(
          totals.costUsd ?? 0,
          9,
        );
        expect(projects.some((row) => row[side].costIncomplete === true)).toBe(
          totals.costIncomplete === true,
        );
      }

      for (const row of projects) {
        expect(row.delta.totalTokens).toBe(row.current.totalTokens - row.baseline.totalTokens);
        expect(row.delta.events).toBe(row.current.events - row.baseline.events);
        expect(row.delta.activeDays).toBe(row.current.activeDays - row.baseline.activeDays);
        expect(row.delta.costUsd ?? 0).toBeCloseTo(
          (row.current.costUsd ?? 0) - (row.baseline.costUsd ?? 0),
          9,
        );
      }

      const costDeltas = projects.map((row) => Math.abs(row.delta.costUsd ?? 0));
      expect(costDeltas).toEqual([...costDeltas].sort((left, right) => right - left));
    }
  });

  it('keeps one label on both sides when a basename collides in only one window', async () => {
    const data = await buildCompareData(
      {
        ...options,
        since: '2026-06-01',
        until: '2026-06-30',
        vsSince: '2026-05-01',
        vsUntil: '2026-05-31',
        byRepo: true,
      },
      fixtureDeps,
    );
    const aApi = data.projects?.find((row) => row.repoRoot === '/w/a/api');

    // May holds only /w/a/api; June adds /w/b/api, so both windows say `a/api`.
    expect(aApi?.project).toBe('a/api');
    expect(aApi?.baseline.events).toBe(1);
    expect(aApi?.current.events).toBe(2);
    expect(data.projects?.map((row) => row.repoRoot)).toEqual([
      '/w/b/api',
      '/w/a/api',
      null,
      '/w/a/api/src',
      '/w/c/tools',
      'C:\\src\\web',
    ]);
    expect(data.projects?.find((row) => row.repoRoot === '/w/b/api')?.baseline).toMatchObject({
      events: 0,
      costUsd: 0,
    });
  });

  it('adds a project table to terminal and markdown output, and nothing without --by-repo', async () => {
    const compareOptions = {
      ...options,
      since: '2026-06-01',
      until: '2026-06-30',
      vsSince: '2026-05-01',
      vsUntil: '2026-05-31',
    };
    const split = await buildCompareData({ ...compareOptions, byRepo: true }, fixtureDeps);
    const plain = await buildCompareData(compareOptions, fixtureDeps);
    const markdown = renderCompareReport(split, 'markdown');

    expect(markdown).toContain('### By project (cost)');
    expect(markdown.split('\n').map(markdownCells)).toContainEqual([
      '\\(unattributed\\)',
      '$0.01',
      '$0.00',
      '+$0.01',
      '-',
    ]);
    expect(renderCompareReport(plain, 'markdown')).not.toContain('By project');
    expect(renderCompareReport(plain, 'terminal', { useColor: false })).not.toContain('By project');
    expect(plain.projects).toBeUndefined();
    expect(
      (JSON.parse(renderCompareReport(plain, 'json')) as { data: object }).data,
    ).not.toHaveProperty('projects');
  });
});
