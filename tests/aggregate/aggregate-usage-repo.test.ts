import { describe, expect, it } from 'vitest';

import { aggregateUsage, type AggregateUsageOptions } from '../../src/aggregate/aggregate-usage.js';
import { buildProjectLabels, toProjectKey } from '../../src/aggregate/project-key.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import type {
  ProjectUsageReportRow,
  UsageReportRow,
  UsageTotals,
} from '../../src/domain/usage-report-row.js';
import type { ReportGranularity } from '../../src/utils/time-buckets.js';
import { mulberry32, pick, randomInt, type Random } from '../helpers/seeded-random.js';

type EventInput = {
  source: string;
  timestamp: string;
  repoRoot?: string;
  machine?: string;
  inputTokens: number;
  costUsd?: number;
  model?: string;
};

function usageEvent(input: EventInput): UsageEvent {
  const { machine, ...rest } = input;
  const event = createUsageEvent({
    sessionId: `${input.source}-${input.timestamp}`,
    costMode: input.costUsd === undefined ? 'estimated' : 'explicit',
    ...rest,
  });

  return machine === undefined ? event : { ...event, machine };
}

function labelsOf(events: readonly UsageEvent[]) {
  return buildProjectLabels(events.map((event) => toProjectKey(event.repoRoot)));
}

const ROOTS = [undefined, '/w/a/api', '/w/b/api', '/w/b/api/', '/w/a/api/src', 'C:\\src\\web'];

function randomEvents(random: Random): UsageEvent[] {
  return Array.from({ length: 1 + randomInt(random, 40) }, () =>
    usageEvent({
      source: pick(random, ['claude', 'codex', 'pi']),
      timestamp: new Date(Date.UTC(2026, 4, 1) + randomInt(random, 90 * 24) * 3_600_000)
        .toISOString()
        .replace('.000', ''),
      repoRoot: pick(random, ROOTS),
      machine: pick(random, [undefined, 'laptop', 'vps']),
      inputTokens: randomInt(random, 1_000),
      costUsd: random() < 0.1 ? undefined : randomInt(random, 500) / 100,
      model: pick(random, [undefined, 'gpt-5', 'claude-sonnet-4-5']),
    }),
  );
}

/** Totals per period, summed over the rows that are not period_combined or grand_total. */
function sumPerPeriod(rows: readonly (UsageReportRow | ProjectUsageReportRow)[]) {
  const sums = new Map<string, UsageTotals>();

  for (const row of rows) {
    if (row.rowType === 'period_combined' || row.rowType === 'grand_total') {
      continue;
    }

    const sum = sums.get(row.periodKey) ?? {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
    sum.inputTokens += row.inputTokens;
    sum.outputTokens += row.outputTokens;
    sum.reasoningTokens += row.reasoningTokens;
    sum.cacheReadTokens += row.cacheReadTokens;
    sum.cacheWriteTokens += row.cacheWriteTokens;
    sum.totalTokens += row.totalTokens;

    if (row.costUsd !== undefined) {
      sum.costUsd = Math.round(((sum.costUsd ?? 0) + row.costUsd) * 100) / 100;
    }

    if (row.costIncomplete) {
      sum.costIncomplete = true;
    }

    sums.set(row.periodKey, sum);
  }

  return sums;
}

function grandTotal(rows: readonly (UsageReportRow | ProjectUsageReportRow)[]) {
  const { modelBreakdown, models, ...totals } = rows.at(-1) ?? {};
  return { totals, models, modelBreakdown };
}

describe('aggregateUsage by project', () => {
  it('keeps every period total and the grand total whatever the split or primary (property)', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = mulberry32(seed);
      const events = randomEvents(random);
      const granularity = pick<ReportGranularity>(random, ['daily', 'weekly', 'monthly']);
      const base: Omit<AggregateUsageOptions, 'primary'> = {
        granularity,
        timezone: pick(random, ['UTC', 'America/New_York']),
        sourceOrder: ['claude', 'codex', 'pi'],
      };
      const projectLabels = labelsOf(events);
      const unsplit = aggregateUsage(events, base);
      const variants = [
        aggregateUsage(events, { ...base, split: { repo: true }, projectLabels }),
        aggregateUsage(events, { ...base, split: { machine: true, repo: true }, projectLabels }),
        aggregateUsage(events, { ...base, primary: 'repo', projectLabels }),
        aggregateUsage(events, {
          ...base,
          split: { machine: true, repo: true },
          projectLabels,
          projectLimit: { count: 1 + randomInt(random, 3), rankedBy: 'cost' },
        }),
      ];

      for (const rows of variants) {
        expect(sumPerPeriod(rows), `seed ${String(seed)}`).toEqual(sumPerPeriod(unsplit));
        expect(grandTotal(rows), `seed ${String(seed)}`).toEqual(grandTotal(unsplit));
      }
    }
  });

  it('splits each source row by project, labelled, with unattributed usage last', () => {
    const events = [
      usageEvent({ source: 'codex', timestamp: '2026-06-15T08:00:00Z', inputTokens: 5 }),
      usageEvent({
        source: 'codex',
        timestamp: '2026-06-15T09:00:00Z',
        repoRoot: '/w/b/api/',
        inputTokens: 7,
      }),
      usageEvent({
        source: 'codex',
        timestamp: '2026-06-15T10:00:00Z',
        repoRoot: '/w/b/api',
        inputTokens: 3,
      }),
      usageEvent({
        source: 'claude',
        timestamp: '2026-06-15T11:00:00Z',
        repoRoot: '/w/a/api',
        inputTokens: 11,
      }),
    ];

    const rows = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      sourceOrder: ['claude', 'codex'],
      split: { repo: true },
      projectLabels: labelsOf(events),
    });

    expect(
      rows.map((row) => [
        row.rowType,
        row.source,
        row.rowType === 'period_source' ? row.repoRoot : '-',
        row.rowType === 'period_source' ? row.project : '-',
        row.inputTokens,
      ]),
    ).toEqual([
      ['period_source', 'claude', '/w/a/api', 'a/api', 11],
      // `/w/b/api/` and `/w/b/api` are one project.
      ['period_source', 'codex', '/w/b/api', 'b/api', 10],
      ['period_source', 'codex', null, '(unattributed)', 5],
      ['period_combined', 'combined', '-', '-', 26],
      ['grand_total', 'combined', '-', '-', 26],
    ]);
  });

  it('keeps the costliest projects of each period and folds the others per source', () => {
    const event = (source: string, day: string, repoRoot: string, costUsd: number) =>
      usageEvent({
        source,
        timestamp: `2026-06-${day}T08:00:00Z`,
        repoRoot,
        inputTokens: 1,
        costUsd,
      });
    const events = [
      // Day 15: big costs most across sources; small and tiny are folded.
      event('claude', '15', '/r/big', 1),
      event('codex', '15', '/r/big', 2),
      event('claude', '15', '/r/small', 2),
      event('claude', '15', '/r/tiny', 0.5),
      event('codex', '15', '/r/tiny', 0.5),
      // Day 16: one project, nothing to fold.
      event('codex', '16', '/r/tiny', 9),
    ];

    const rows = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      sourceOrder: ['claude', 'codex'],
      split: { repo: true },
      projectLabels: labelsOf(events),
      projectLimit: { count: 1, rankedBy: 'cost' },
    });

    expect(
      rows.flatMap((row) =>
        row.rowType === 'period_source'
          ? [[row.periodKey, row.source, row.project, row.otherProjects, row.costUsd]]
          : [],
      ),
    ).toEqual([
      ['2026-06-15', 'claude', 'big', undefined, 1],
      ['2026-06-15', 'claude', '2 other projects', 2, 2.5],
      ['2026-06-15', 'codex', 'big', undefined, 2],
      ['2026-06-15', 'codex', '1 other project', 1, 0.5],
      ['2026-06-16', 'codex', 'tiny', undefined, 9],
    ]);
    expect(
      rows.find((row) => row.rowType === 'period_source' && row.otherProjects),
    ).not.toHaveProperty('repoRoot');
  });

  it('ranks a period by tokens when a project has no price, and never folds a lone project', () => {
    const event = (repoRoot: string, inputTokens: number, costUsd?: number) =>
      usageEvent({
        source: 'pi',
        timestamp: '2026-06-15T08:00:00Z',
        repoRoot,
        inputTokens,
        ...(costUsd === undefined ? {} : { costUsd }),
      });
    const projectsOf = (events: UsageEvent[]) =>
      aggregateUsage(events, {
        granularity: 'daily',
        timezone: 'UTC',
        split: { repo: true },
        projectLabels: labelsOf(events),
        projectLimit: { count: 1, rankedBy: 'cost' },
      }).flatMap((row) => (row.rowType === 'period_source' ? [row.project] : []));

    expect(
      projectsOf([
        event('/r/priced', 10, 5),
        event('/r/unpriced', 10_000),
        event('/r/cheap', 5, 1),
      ]),
    ).toEqual(['unpriced', '2 other projects']);
    expect(projectsOf([event('/r/priced', 10, 5), event('/r/cheap', 5, 1)])).toEqual([
      'cheap',
      'priced',
    ]);
  });

  it('emits a combined row when one source has several projects in a period', () => {
    const events = [
      usageEvent({ source: 'pi', timestamp: '2026-06-15T08:00:00Z', inputTokens: 1 }),
      usageEvent({
        source: 'pi',
        timestamp: '2026-06-15T09:00:00Z',
        repoRoot: '/r/one',
        inputTokens: 2,
      }),
    ];
    const options = { granularity: 'daily', timezone: 'UTC' } as const;

    expect(aggregateUsage(events, options).map((row) => row.rowType)).toEqual([
      'period_source',
      'grand_total',
    ]);
    expect(
      aggregateUsage(events, {
        ...options,
        split: { repo: true },
        projectLabels: labelsOf(events),
      }).map((row) => row.rowType),
    ).toEqual(['period_source', 'period_source', 'period_combined', 'grand_total']);
  });

  it('orders machine and project splits by source, then machine, then project', () => {
    const events = [
      usageEvent({
        source: 'claude',
        timestamp: '2026-06-15T08:00:00Z',
        repoRoot: '/r/zeta',
        machine: 'laptop',
        inputTokens: 1,
      }),
      usageEvent({
        source: 'claude',
        timestamp: '2026-06-15T09:00:00Z',
        repoRoot: '/r/alpha',
        machine: 'laptop',
        inputTokens: 2,
      }),
      usageEvent({
        source: 'claude',
        timestamp: '2026-06-15T10:00:00Z',
        repoRoot: '/r/zeta',
        inputTokens: 4,
      }),
    ];

    const rows = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      split: { machine: true, repo: true },
      projectLabels: labelsOf(events),
    });

    expect(
      rows.flatMap((row) =>
        row.rowType === 'period_source' ? [[row.machine, row.project, row.inputTokens]] : [],
      ),
    ).toEqual([
      ['local', 'zeta', 4],
      ['laptop', 'alpha', 2],
      ['laptop', 'zeta', 1],
    ]);
  });

  it('yields one period_project row per project across sources with primary repo', () => {
    const events = [
      usageEvent({
        source: 'claude',
        timestamp: '2026-06-15T08:00:00Z',
        repoRoot: '/w/a/api',
        inputTokens: 1,
        model: 'claude-sonnet-4-5',
      }),
      usageEvent({
        source: 'codex',
        timestamp: '2026-06-15T09:00:00Z',
        repoRoot: '/w/a/api',
        inputTokens: 2,
        model: 'gpt-5',
      }),
      usageEvent({ source: 'codex', timestamp: '2026-06-16T09:00:00Z', inputTokens: 4 }),
    ];

    const rows = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      primary: 'repo',
      split: { machine: true },
      projectLabels: labelsOf(events),
    });

    expect(rows).toMatchObject([
      {
        rowType: 'period_project',
        periodKey: '2026-06-15',
        repoRoot: '/w/a/api',
        project: 'api',
        models: ['gpt-5', 'claude-sonnet-4-5'],
        inputTokens: 3,
      },
      { rowType: 'period_project', periodKey: '2026-06-16', repoRoot: null, inputTokens: 4 },
      { rowType: 'grand_total', inputTokens: 7 },
    ]);
    expect(rows[0]).not.toHaveProperty('source');
    expect(rows[0]).not.toHaveProperty('machine');
  });

  it('leaves rows without project fields when nothing splits by project', () => {
    const events = [
      usageEvent({
        source: 'claude',
        timestamp: '2026-06-15T08:00:00Z',
        repoRoot: '/w/a/api',
        inputTokens: 1,
      }),
    ];

    const [row] = aggregateUsage(events, {
      granularity: 'daily',
      timezone: 'UTC',
      split: { machine: true },
    });

    expect(Object.keys(row)).toEqual(
      expect.not.arrayContaining(['repoRoot', 'project'] as string[]),
    );
    expect(row).toMatchObject({ machine: 'local' });
  });

  it('refuses to split by project without the report labels', () => {
    const events = [
      usageEvent({ source: 'claude', timestamp: '2026-06-15T08:00:00Z', inputTokens: 1 }),
    ];

    expect(() =>
      aggregateUsage(events, { granularity: 'daily', timezone: 'UTC', split: { repo: true } }),
    ).toThrow('No project label for unattributed usage');
  });
});
