import { stripVTControlCharacters } from 'node:util';

import pc from 'picocolors';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { aggregateProjects, buildProjectsData } from '../../src/cli/build-projects-data.js';
import { buildProjectsReport } from '../../src/cli/run-projects-report.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { renderProjectsReportWithNotes } from '../../src/render/render-projects-report.js';
import { readFrom } from '../helpers/fake-read.js';
import { freezeDate } from '../golden/golden-harness.js';
import { createProjectFixtureAdapters } from '../golden/m9-project-fixture.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

function event(input: {
  timestamp: string;
  repoRoot?: string;
  costUsd?: number;
  totalTokens?: number;
  model?: string;
  source?: string;
}): UsageEvent {
  const tokens = input.totalTokens ?? 100;

  return createUsageEvent({
    source: input.source ?? 'claude',
    sessionId: 's',
    timestamp: input.timestamp,
    provider: 'anthropic',
    model: input.model ?? 'claude-sonnet-4-5',
    inputTokens: tokens,
    outputTokens: 0,
    ...(input.repoRoot === undefined ? {} : { repoRoot: input.repoRoot }),
    ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
  });
}

describe('aggregateProjects', () => {
  it('splits shares of the window cost that sum to 1 when every cost is known', () => {
    const costs = [0.1, 0.2, 0.3, 0.07, 0.33];
    const events = costs.map((costUsd, index) =>
      event({
        timestamp: `2026-06-0${String(index + 1)}T10:00:00.000Z`,
        repoRoot: `/p/${String(index)}`,
        costUsd,
      }),
    );

    const data = aggregateProjects(events, { timezone: 'UTC' });
    const shareSum = data.projects.reduce((sum, project) => sum + (project.costShare ?? 0), 0);

    expect(data.projects).toHaveLength(costs.length);
    expect(shareSum).toBeCloseTo(1, 9);
    expect(data.projects.map((project) => project.costUsd)).toEqual(
      [...costs].sort((left, right) => right - left),
    );
  });

  it('keeps project totals summing to the window totals', () => {
    const events = [
      event({
        timestamp: '2026-05-01T10:00:00.000Z',
        repoRoot: '/a',
        costUsd: 0.5,
        totalTokens: 10,
      }),
      event({
        timestamp: '2026-06-01T10:00:00.000Z',
        repoRoot: '/a',
        costUsd: 0.25,
        totalTokens: 20,
      }),
      event({ timestamp: '2026-06-02T10:00:00.000Z', costUsd: 0.125, totalTokens: 40 }),
    ];

    const data = aggregateProjects(events, { timezone: 'UTC', granularity: 'daily' });

    expect(data.projects.reduce((sum, project) => sum + project.totalTokens, 0)).toBe(
      data.totals.totalTokens,
    );
    expect(data.totals).toMatchObject({ costUsd: 0.875, projects: 2, events: 3, activeDays: 3 });
    expect(data.projects[0]).toMatchObject({ repoRoot: '/a', costUsd: 0.75, events: 2 });
  });

  it('reports usage without a repository root as one (unattributed) row with a null root', () => {
    const data = aggregateProjects(
      [
        event({ timestamp: '2026-06-01T10:00:00.000Z', costUsd: 1, source: 'claude' }),
        event({ timestamp: '2026-06-01T11:00:00.000Z', costUsd: 1, source: 'codex' }),
      ],
      { timezone: 'UTC' },
    );

    expect(data.projects).toEqual([
      expect.objectContaining({
        repoRoot: null,
        project: '(unattributed)',
        events: 2,
        costShare: 1,
      }),
    ]);
  });

  it('labels projects that share a basename by their parents, one row per root', () => {
    const data = aggregateProjects(
      [
        event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/w/a/api', costUsd: 3 }),
        event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/w/b/api/', costUsd: 1 }),
        event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/w/b/api', costUsd: 1 }),
      ],
      { timezone: 'UTC' },
    );

    expect(data.projects.map((project) => [project.repoRoot, project.project])).toEqual([
      ['/w/a/api', 'a/api'],
      ['/w/b/api', 'b/api'],
    ]);
  });

  it('returns no projects and a zero cost for an empty window', () => {
    const data = aggregateProjects([], { timezone: 'UTC', granularity: 'monthly' });

    expect(data.projects).toEqual([]);
    expect(data.periods).toEqual([]);
    expect(data.totals).toMatchObject({
      totalTokens: 0,
      costUsd: 0,
      projects: 0,
      events: 0,
      activeDays: 0,
    });
  });

  it('marks costs incomplete and gives an unpriced project no share', () => {
    const data = aggregateProjects(
      [
        event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/priced', costUsd: 1 }),
        event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/unpriced', totalTokens: 999 }),
      ],
      { timezone: 'UTC' },
    );

    expect(data.totals).toMatchObject({ costUsd: 1, costIncomplete: true });
    expect(data.projects).toEqual([
      expect.objectContaining({ repoRoot: '/priced', costShare: 1 }),
      expect.objectContaining({ repoRoot: '/unpriced', costIncomplete: true, costShare: null }),
    ]);
  });

  it('orders equal costs by tokens, then by label', () => {
    const data = aggregateProjects(
      [
        event({
          timestamp: '2026-06-01T10:00:00.000Z',
          repoRoot: '/b',
          costUsd: 1,
          totalTokens: 5,
        }),
        event({
          timestamp: '2026-06-01T10:00:00.000Z',
          repoRoot: '/a',
          costUsd: 1,
          totalTokens: 5,
        }),
        event({
          timestamp: '2026-06-01T10:00:00.000Z',
          repoRoot: '/c',
          costUsd: 1,
          totalTokens: 9,
        }),
      ],
      { timezone: 'UTC' },
    );

    expect(data.projects.map((project) => project.project)).toEqual(['c', 'a', 'b']);
  });

  it('counts active days in the report timezone', () => {
    const events = [
      event({ timestamp: '2026-06-01T23:30:00.000Z', repoRoot: '/a' }),
      event({ timestamp: '2026-06-02T00:30:00.000Z', repoRoot: '/a' }),
    ];

    expect(aggregateProjects(events, { timezone: 'UTC' }).projects[0].activeDays).toBe(2);
    expect(aggregateProjects(events, { timezone: 'America/New_York' }).projects[0].activeDays).toBe(
      1,
    );
  });

  it('names at most three top models, most tokens first', () => {
    const models = ['m-small', 'm-big', 'm-mid', 'm-tiny'];
    const tokens = [20, 400, 300, 10];
    const events = models.map((model, index) =>
      event({
        timestamp: '2026-06-01T10:00:00.000Z',
        repoRoot: '/a',
        model,
        totalTokens: tokens[index],
      }),
    );

    expect(aggregateProjects(events, { timezone: 'UTC' }).projects[0].topModels).toEqual([
      'm-big',
      'm-mid',
      'm-small',
    ]);
  });

  it('keeps the top N projects by window cost and only their period rows', () => {
    const events = [
      // /steady costs more over the window; /spike wins one month only.
      event({ timestamp: '2026-05-01T10:00:00.000Z', repoRoot: '/steady', costUsd: 2 }),
      event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/steady', costUsd: 2 }),
      event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/spike', costUsd: 3 }),
      event({ timestamp: '2026-06-01T10:00:00.000Z', repoRoot: '/small', costUsd: 0.5 }),
    ];

    const data = aggregateProjects(events, { timezone: 'UTC', granularity: 'monthly', top: 1 });

    expect(data.projects.map((project) => project.project)).toEqual(['steady']);
    expect(data.totals).toMatchObject({ costUsd: 7.5, projects: 3 });
    // Rounded to 6 places, as value's costShare.
    expect(data.projects[0].costShare).toBe(0.533333);
    expect(data.periods?.map((row) => [row.periodKey, row.project, row.costUsd])).toEqual([
      ['2026-05', 'steady', 2],
      ['2026-06', 'steady', 2],
    ]);
  });
});

describe('projects report', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const deps = { createAdapters: createProjectFixtureAdapters };
  const options = { timezone: 'UTC', pricingOffline: true } as const;

  // picocolors styles only where color is supported, as under CI.
  it.skipIf(!pc.isColorSupported)(
    'bolds the table headers without changing the layout',
    async () => {
      const data = await buildProjectsData(options, deps);
      const colored = renderProjectsReportWithNotes(data, 'terminal', {
        useColor: true,
        terminalWidth: 120,
      }).output;
      const plain = renderProjectsReportWithNotes(data, 'terminal', {
        useColor: false,
        terminalWidth: 120,
      }).output;

      expect(colored).toContain(`│ ${pc.bold('Project')}`);
      expect(stripVTControlCharacters(colored)).toBe(plain);
    },
  );

  it('covers full history by default and the last N months with --last', async () => {
    const countEvents = async (windowOptions: { last?: string; all?: boolean }) =>
      (
        JSON.parse(
          await buildProjectsReport({ ...options, ...windowOptions, json: true }, deps),
        ) as { data: { totals: { events: number } } }
      ).data.totals.events;

    // FIXED_NOW is in June 2026: the fixture has 10 events in June and 2 in May.
    expect(await countEvents({})).toBe(12);
    expect(await countEvents({ all: true })).toBe(12);
    expect(await countEvents({ last: '1' })).toBe(10);
    expect(await countEvents({ last: '2' })).toBe(12);
  });

  it('rejects --last with dates or --all, and a --top that is not a non-negative integer', async () => {
    await expect(
      buildProjectsReport({ ...options, last: '2', since: '2026-01-01' }, deps),
    ).rejects.toThrow('--last cannot be combined');
    await expect(buildProjectsReport({ ...options, last: '2', all: true }, deps)).rejects.toThrow(
      '--last cannot be combined',
    );

    for (const top of ['-1', '1.5', 'x']) {
      await expect(buildProjectsReport({ ...options, top }, deps)).rejects.toThrow(
        '--top must be a non-negative integer',
      );
    }
  });

  it('rejects --compact and --no-cost with --json', async () => {
    await expect(
      buildProjectsReport({ ...options, compact: true, json: true }, deps),
    ).rejects.toThrow('--compact applies to terminal and markdown tables');
    await expect(
      buildProjectsReport({ ...options, cost: false, json: true }, deps),
    ).rejects.toThrow('--no-cost applies to tables');
  });

  it('leaves out Cost and Share with --no-cost, and Events and Active Days with --compact', async () => {
    const noCost = await buildProjectsReport({ ...options, markdown: true, cost: false }, deps);
    const compact = await buildProjectsReport({ ...options, markdown: true, compact: true }, deps);
    const header = (output: string) => output.split('\n')[0];

    expect(header(noCost)).not.toMatch(/Cost|Share/u);
    expect(header(noCost)).toContain('Active Days');
    expect(header(compact)).not.toMatch(/Events|Active Days/u);
    expect(compact).toContain('17.9K');
  });

  it('marks a TOTAL that covers projects --top left out, and lists per-period rows', async () => {
    const output = await buildProjectsReport(
      { ...options, markdown: true, top: '2', granularity: 'weekly' },
      deps,
    );

    expect(output).toContain('TOTAL \\(all 6\\)');
    expect(output).toContain('| Week ');
    expect(output).toContain('2026-W25');
    expect(output).not.toContain('tools');
  });

  it('shows the top 10 projects by default, in JSON too, and every project with --top 0', async () => {
    const createAdapters = (): SourceAdapter[] => [
      {
        id: 'claude',
        discoverFiles: async () => ['/projects-test/claude.jsonl'],
        read: readFrom(async () =>
          Array.from({ length: 12 }, (_, index) =>
            event({
              timestamp: '2026-06-01T10:00:00.000Z',
              repoRoot: `/w/p${String(index)}`,
              costUsd: index + 1,
            }),
          ),
        ),
      },
    ];
    const byDefault = await buildProjectsData({ ...options, json: true }, { createAdapters });

    expect(byDefault.projects.map((project) => project.project)).toEqual(
      Array.from({ length: 10 }, (_, index) => `p${String(11 - index)}`),
    );
    expect(byDefault.totals).toMatchObject({ projects: 12, costUsd: 78 });
    expect(byDefault.limitNote).toBe(
      'Showing the top 10 of 12 projects by cost over the whole window. Use --top 0 for all.',
    );

    const all = await buildProjectsData({ ...options, top: '0' }, { createAdapters });
    expect(all.projects).toHaveLength(12);
    expect(all.limitNote).toBeUndefined();
  });

  it('prints the empty message when filters match nothing', async () => {
    const output = await buildProjectsReport({ ...options, repo: ['no-such-project'] }, deps);

    expect(output).toContain('No usage data found for the selected filters.');
  });
});
