import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ShareReport } from '../../../../src/share-report/client/core/index.js';
import { buildCompareView } from '../../../../src/share-report/client/ui/panels/compare-model.js';
import { buildEfficiencyView } from '../../../../src/share-report/client/ui/panels/efficiency-model.js';
import { buildOptimizeView } from '../../../../src/share-report/client/ui/panels/optimize-model.js';
import { buildWrappedView } from '../../../../src/share-report/client/ui/panels/wrapped-model.js';
import {
  createLabels,
  createMaskSource,
  HIDDEN_LABEL,
} from '../../../../src/share-report/client/ui/state/context.js';
import type { ShareEmbeddedEnvelope } from '../../../../src/share-report/types.js';
import {
  defined,
  HOST_TIMEZONES,
  loadFixtureReport,
  useHostTimezone,
} from '../core/share-fixture.js';

type Report = ShareEmbeddedEnvelope['report'];

/** The `data` of a committed report golden: the CLI's real `--json` shape on synthetic logs. */
function readGolden(name: string): ShareEmbeddedEnvelope['data'] {
  const file = path.resolve('tests/golden/__goldens__/reports', `${name}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { data: ShareEmbeddedEnvelope['data'] }).data;
}

function withEnvelope(report: Report, data: unknown): ShareReport {
  return loadFixtureReport((payload) => {
    payload.envelope = { schemaVersion: 1, report, data: data as ShareEmbeddedEnvelope['data'] };
  });
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

const texts = (cells: { text: string }[]) => cells.map((cell) => cell.text);

describe('panel models', () => {
  it('reads nothing from another command’s envelope or a malformed one', () => {
    const efficiency = withEnvelope('efficiency', readGolden('efficiency-monthly'));
    const labels = createLabels(efficiency, undefined);

    expect(buildWrappedView(efficiency)).toBeUndefined();
    expect(buildCompareView(efficiency, labels)).toBeUndefined();
    expect(buildOptimizeView(efficiency)).toBeUndefined();
    expect(buildWrappedView(withEnvelope('wrapped', { year: 'last' }))).toBeUndefined();
    expect(buildEfficiencyView(withEnvelope('efficiency', { rows: 'none' }))).toBeUndefined();
    expect(buildOptimizeView(withEnvelope('optimize', { 0: {} }))).toBeUndefined();
    expect(buildCompareView(withEnvelope('compare', { current: {} }), labels)).toBeUndefined();
  });
});

for (const timezone of HOST_TIMEZONES) {
  describe(`wrapped recap (host ${timezone})`, () => {
    useHostTimezone(timezone);
    const view = defined(buildWrappedView(withEnvelope('wrapped', readGolden('wrapped'))));

    it('leads with the year’s tokens, cost and active days', () => {
      expect(view.lede.map((part) => part.text).join('')).toBe(
        '4.61K tokens and ~$0.67 across 11 active days in 2026.',
      );
      expect(view.lede.filter((part) => part.figure).map((part) => part.text)).toEqual([
        '4.61K',
        '~$0.67',
        '11',
      ]);
    });

    it('lists the recap facts as the terminal recap states them', () => {
      expect(Object.fromEntries(view.facts.map((fact) => [fact.label, fact.value]))).toEqual({
        'Active time': '25m',
        'Longest streak': '2 days',
        'Peak hour': '14:00',
        Weekdays: '91.3%',
        'Busiest day': '11 Sep 2026',
        'Cache savings': '~$0.00',
        Events: '25',
        Sessions: '19',
      });
    });

    it('places every day of the year on its own weekday row, in Monday-first weeks', () => {
      const { calendar } = view;

      expect(calendar.days).toHaveLength(365);
      expect(calendar.weeks).toBe(53);
      // 2026-01-01 is a Thursday, 2026-12-31 too.
      expect(calendar.days[0]).toMatchObject({ week: 0, weekday: 3, level: 0 });
      expect(calendar.days[364]).toMatchObject({ week: 52, weekday: 3 });

      calendar.days.forEach((day, index) => {
        const date = new Date(Date.UTC(2026, 0, 1 + index));
        expect(day.weekday).toBe((date.getUTCDay() + 6) % 7);
        expect(day.week).toBe(Math.floor((index + 3) / 7));
      });

      expect(calendar.months.map((month) => month.label)).toHaveLength(12);
      expect(calendar.months[0]).toEqual({ label: 'Jan', week: 0 });
      expect(calendar.summary).toBe(
        'Daily tokens in 2026: usage on 11 days of 365. The monthly table holds the totals.',
      );
    });

    it('carries the CLI’s heat levels and names each day with its tokens', () => {
      const busiest = defined(
        view.calendar.days.find((day) => day.label.startsWith('11 Sep 2026')),
      );

      expect(busiest).toMatchObject({ level: 4, label: '11 Sep 2026: 2,440 tokens' });
      expect(view.calendar.days[0].label).toBe('1 Jan 2026: no usage');
    });

    it('keeps the CLI’s ranking in the top lists and scales bars to the largest cost', () => {
      const [models, sources] = view.topLists;

      expect(models.items.map((item) => item.name)).toEqual([
        'gpt-4.1',
        'claude-kilocode-e2e',
        'gpt-roocode-e2e',
        'claude-sonnet-cline-e2e',
        'gpt-5.2-codex',
      ]);
      expect(models.items[0]).toMatchObject({ rank: 1, cost: '$0.60', share: 1 });
      expect(models.items[1].share).toBeCloseTo(0.05);
      expect(models.items[4]).toMatchObject({ tokens: '390', tokensExact: '390 tokens' });
      expect(sources.title).toBe('Top sources');
    });

    it('states each month’s tokens and cost, marking lower bounds and months without cost', () => {
      const rows = view.months.rows;

      expect(rows).toHaveLength(12);
      expect(texts(rows[0])).toEqual(['Jan', '450', '$0.50']);
      expect(texts(rows[2])).toEqual(['Mar', '0', '—']);
      expect(rows[5][2].text).toBe('~$0.06');
      expect(rows[5][2].note).toMatch(/lower bound/u);
    });
  });
}

describe('wrapped recap without optional figures', () => {
  it('shows dashes for a --no-cost year with no usage instead of failing', () => {
    const view = defined(
      buildWrappedView(
        withEnvelope('wrapped', {
          year: 2027,
          timezone: 'UTC',
          totalTokens: 0,
          activeDays: 0,
          longestStreak: 0,
          activeMs: 0,
          weekdayTokens: 0,
          weekendTokens: 0,
          eventCount: 0,
          sessionCount: 0,
          topModels: [],
          topSources: [],
          monthlyIntensity: [],
          dailyIntensity: [],
        }),
      ),
    );

    expect(view.lede.map((part) => part.text).join('')).toBe(
      '0 tokens across 0 active days in 2027.',
    );
    expect(view.facts.find((fact) => fact.label === 'Peak hour')?.value).toBe('—');
    expect(view.facts.find((fact) => fact.label === 'Weekdays')?.value).toBe('—');
    expect(view.facts.some((fact) => fact.label === 'Cache savings')).toBe(false);
    expect(view.topLists).toEqual([]);
    expect(view.calendar).toMatchObject({ weeks: 0, days: [] });
  });

  it('scales top-list bars by tokens when the list has no cost', () => {
    const view = defined(
      buildWrappedView(
        withEnvelope('wrapped', {
          ...record(readGolden('wrapped')),
          topModels: [
            { name: 'a', totalTokens: 400 },
            { name: 'b', totalTokens: 100 },
          ],
        }),
      ),
    );

    expect(view.topLists[0].items.map((item) => [item.cost, item.share])).toEqual([
      ['—', 1],
      ['—', 0.25],
    ]);
  });
});

describe('efficiency panel', () => {
  it('heads the panel with the totals and lists each period with the total under a rule', () => {
    const view = defined(
      buildEfficiencyView(withEnvelope('efficiency', readGolden('efficiency-monthly'))),
    );

    expect(view.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Commits', '1'],
      ['Lines changed', '2'],
      ['Cost per commit', '$0.00'],
      ['Cost per 1k lines', '$0.71'],
      ['Tokens per commit', '195'],
    ]);
    expect(view.facts[1].detail).toBe('1 added, 1 deleted');

    const [table] = view.tables;
    expect(table.columns.map((column) => column.label)).not.toContain('Source');
    expect(texts(table.rows[0])).toEqual([
      '2026-06',
      '1',
      '1',
      '1',
      '220',
      '$0.00',
      '$0.00',
      '$0.71',
      '195',
    ]);
    expect(texts(table.foot[0])[0]).toBe('Total');
  });

  it('adds a source column with --by-source rows', () => {
    const data = record(readGolden('efficiency-monthly'));
    const rows = data.rows as Record<string, unknown>[];
    const view = defined(
      buildEfficiencyView(
        withEnvelope('efficiency', {
          grouping: 'source',
          rows: [{ ...rows[0], rowType: 'period_source', source: 'codex' }, rows[1]],
        }),
      ),
    );
    const [table] = view.tables;

    expect(table.columns.slice(0, 3).map((column) => column.label)).toEqual([
      'Period',
      'Source',
      'Commits',
    ]);
    expect(texts(table.rows[0]).slice(0, 2)).toEqual(['2026-06', 'codex']);
    expect(texts(table.foot[0]).slice(0, 2)).toEqual(['Total', '']);
    expect(table.foot[0]).toHaveLength(table.columns.length);
  });

  it('says so when no period had a commit', () => {
    const view = defined(
      buildEfficiencyView(withEnvelope('efficiency', { grouping: 'period', rows: [] })),
    );

    expect(view).toMatchObject({ facts: [], tables: [] });
    expect(view.note).toMatch(/^No period in this window had a commit\./u);
  });
});

describe('optimize panel', () => {
  const golden = readGolden('optimize-monthly') as Record<string, unknown>[];

  it('puts each candidate beside its period’s baseline, with the window total under a rule', () => {
    const view = defined(buildOptimizeView(withEnvelope('optimize', golden)));
    const [table] = view.tables;

    expect(table.rows.map(texts)).toEqual([
      ['2026-01', 'gpt-4.1', '$0.00', '$0.50', '+$0.50', '99.7%', ''],
      ['2026-02', 'gpt-4.1', '$0.00', '$0.10', '+$0.10', '99.6%', ''],
      [
        '2026-06',
        'gpt-4.1',
        '$0.00',
        '~$0.02',
        '—',
        '—',
        'baseline is a lower bound; cache writes priced as input',
      ],
    ]);
    expect(texts(table.foot[0]).slice(0, 4)).toEqual(['Total', 'gpt-4.1', '$0.00', '~$0.62']);
  });

  it('reports no best candidate when the window total has no savings', () => {
    const view = defined(buildOptimizeView(withEnvelope('optimize', golden)));

    expect(view.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Provider', 'openai'],
      ['Baseline cost', '~$0.62'],
      ['Best candidate', 'Unavailable'],
    ]);
  });

  it('picks the candidate that saves the most over the whole window', () => {
    const total = golden.filter((row) => row.periodKey === 'ALL');
    const candidate = defined(total.find((row) => row.rowType === 'candidate'));
    const rows = [
      ...total.filter((row) => row.rowType === 'baseline'),
      { ...candidate, candidateModel: 'cheap', savingsUsd: 0.5, savingsRatio: 0.8 },
      { ...candidate, candidateModel: 'cheaper', savingsUsd: 0.6, savingsRatio: 0.96 },
      { ...candidate, candidateModel: 'dearer', savingsUsd: -0.1, savingsRatio: -0.16 },
    ];
    const view = defined(buildOptimizeView(withEnvelope('optimize', rows)));

    expect(view.facts[2]).toEqual({
      label: 'Best candidate',
      value: 'cheaper',
      detail: '+$0.60 saved (96.0%)',
    });
    expect(texts(view.tables[0].foot[2])[4]).toBe('−$0.10');
  });

  it('says so when the window had no usage to compare', () => {
    const view = defined(buildOptimizeView(withEnvelope('optimize', [])));

    expect(view.tables).toEqual([]);
    expect(view.note).toMatch(/^No usage to compare in this window\./u);
  });
});

describe('compare panel', () => {
  const report = withEnvelope('compare', readGolden('compare-by-repo'));

  it('names both windows and leads with the token and cost change', () => {
    const view = defined(buildCompareView(report, createLabels(report, undefined)));

    expect(view.facts).toEqual([
      { label: 'Current', value: '2026-06', detail: '1 Jun 2026 – 30 Jun 2026' },
      { label: 'Baseline', value: '2026-05', detail: '1 May 2026 – 31 May 2026' },
      { label: 'Total tokens change', value: '+30,990', detail: '+1,126.9%' },
      { label: 'Cost change', value: '+$0.08', detail: '+655.1%' },
    ]);
  });

  it('signs every change and leaves out a percentage the CLI could not compute', () => {
    const view = defined(buildCompareView(report, createLabels(report, undefined)));
    const [totals] = view.tables;
    const row = (label: string) =>
      texts(defined(totals.rows.find((cells) => cells[0].text === label)));

    expect(totals.columns[1].label).toBe('Current (2026-06)');
    expect(row('Input')).toEqual(['Input', '17,800', '2,200', '+15,600', '+709.1%']);
    expect(row('Cache read')).toEqual(['Cache read', '12,000', '0', '+12,000', '—']);
    expect(row('Active days')).toEqual(['Active days', '1', '2', '−1', '−50.0%']);
    expect(row('Cost')).toEqual(['Cost', '$0.09', '$0.01', '+$0.08', '+655.1%']);
  });

  it('marks a cost that is a lower bound on either side', () => {
    const plain = withEnvelope('compare', readGolden('compare'));
    const view = defined(buildCompareView(plain, createLabels(plain, undefined)));
    const cost = defined(view.tables[0].rows.find((cells) => cells[0].text === 'Cost'));

    expect(texts(cost)).toEqual(['Cost', '~$0.06', '$0.00', '~+$0.06', '+6,251.6%']);
    expect(view.tables.map((table) => table.title)).toEqual(['Totals', 'By source (cost)']);
  });

  it('breaks down by source and project by cost, and by tokens in a file without cost', () => {
    const view = defined(buildCompareView(report, createLabels(report, undefined)));

    expect(view.tables.map((table) => table.title)).toEqual([
      'Totals',
      'By source (cost)',
      'By project (cost)',
    ]);
    expect(texts(view.tables[2].rows[0])).toEqual(['b/api', '$0.03', '$0.00', '+$0.03', '—']);

    const data = record(readGolden('compare-by-repo'));
    const dropCost = (row: Record<string, unknown>) => {
      const strip = (side: unknown) => {
        const copy = { ...record(side) };
        delete copy.costUsd;
        return copy;
      };
      return {
        ...row,
        current: strip(row.current),
        baseline: strip(row.baseline),
        delta: strip(row.delta),
      };
    };
    const noCost = withEnvelope('compare', {
      ...data,
      sources: (data.sources as Record<string, unknown>[]).map(dropCost),
    });
    const tokens = defined(buildCompareView(noCost, createLabels(noCost, undefined))).tables[1];

    expect(tokens.title).toBe('By source (tokens)');
    expect(texts(tokens.rows[0])).toEqual(['claude', '20,050', '1,500', '+18,550', '+1,236.7%']);
  });

  it('hides project names the file does not hold while Hide names is on', () => {
    const hidden = createLabels(report, createMaskSource(report)());
    const view = defined(buildCompareView(report, hidden));
    const projects = view.tables[2].rows.map((cells) => cells[0].text);

    expect(projects).not.toContain('b/api');
    expect(new Set(projects)).toEqual(new Set([HIDDEN_LABEL, '(unattributed)']));
  });
});
