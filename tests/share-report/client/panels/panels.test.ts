import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ShareReport } from '../../../../src/share-report/client/core/index.js';
import { buildCompareView } from '../../../../src/share-report/client/ui/panels/compare-model.js';
import { buildEfficiencyView } from '../../../../src/share-report/client/ui/panels/efficiency-model.js';
import { buildOptimizeView } from '../../../../src/share-report/client/ui/panels/optimize-model.js';
import { buildSummaryView } from '../../../../src/share-report/client/ui/panels/summary-model.js';
import { buildTrendsView } from '../../../../src/share-report/client/ui/panels/trends-model.js';
import { buildWrappedView } from '../../../../src/share-report/client/ui/panels/wrapped-model.js';
import {
  createLabels,
  createMaskSource,
  HIDDEN_LABEL,
  type ShareLabels,
} from '../../../../src/share-report/client/ui/state/context.js';
import type { LedePart, PanelTable } from '../../../../src/share-report/client/ui/panels/model.js';
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

/** A wrapped file for 2026 as the CLI writes it: the window is the year. */
function wrappedReport(generatedAt: string, data: unknown = readGolden('wrapped')): ShareReport {
  return loadFixtureReport((payload) => {
    payload.meta.window = { since: '2026-01-01', until: '2026-12-31' };
    payload.meta.generatedAt = generatedAt;
    payload.envelope = {
      schemaVersion: 1,
      report: 'wrapped',
      data: data as ShareEmbeddedEnvelope['data'],
    };
  });
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

const texts = (cells: { text: string }[]) => cells.map((cell) => cell.text);

/** The view's table with that title. */
function tableOf(view: { tables: PanelTable[] }, title: string): PanelTable {
  return defined(view.tables.find((table) => table.title === title));
}

const ledeText = (view: { lede: LedePart[] }) => view.lede.map((part) => part.text).join('');
const ledeFigures = (view: { lede: LedePart[] }) =>
  view.lede.filter((part) => part.figure).map((part) => part.text);

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
    expect(buildSummaryView(efficiency, labels)).toBeUndefined();
    expect(buildSummaryView(withEnvelope('summary', { periods: [] }), labels)).toBeUndefined();
    expect(buildTrendsView(efficiency, labels)).toBeUndefined();
    expect(
      buildTrendsView(withEnvelope('trends', { metric: 'cups', totalSeries: {} }), labels),
    ).toBeUndefined();
  });
});

for (const timezone of HOST_TIMEZONES) {
  describe(`wrapped recap (host ${timezone})`, () => {
    useHostTimezone(timezone);
    const view = defined(buildWrappedView(wrappedReport('2027-01-02T08:00:00.000Z')));

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
        // wrapped.txt: Hours <1h for activeMs 1,501,000.
        'Active time': '<1h',
        'Longest streak': '2 days',
        'Peak hour': '14:00',
        Weekdays: '91.3%',
        'Busiest day': '11 Sep 2026',
        'Cache savings': '~$0.00',
        Events: '25',
        Sessions: '19',
      });
    });

    it('lists the calendar’s days with usage as its table', () => {
      // wrapped.txt: 11 active days; busiest day 2026-09-11 with 2,440 tokens.
      const { table } = view.calendar;

      expect(table.columns.map((column) => column.label)).toEqual(['Day', 'Tokens']);
      expect(table.rows).toHaveLength(11);
      expect(table.rows.map(texts)).toContainEqual(['11 Sep 2026', '2,440']);
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

describe('wrapped recap of the current year', () => {
  it('stops the calendar and the monthly table at the generation date', () => {
    // 27 Oct 2026, 09:00 in Europe/Paris.
    const view = defined(buildWrappedView(wrappedReport('2026-10-27T08:00:00.000Z')));

    expect(view.calendar.days).toHaveLength(300);
    expect(view.calendar.days.at(-1)?.label).toMatch(/^27 Oct 2026: /u);
    expect(view.calendar.weeks).toBe(44);
    expect(view.calendar.months.map((month) => month.label).at(-1)).toBe('Oct');
    expect(view.calendar.summary).toBe(
      'Daily tokens in 2026: usage on 11 days of 300. The monthly table holds the totals.',
    );
    expect(view.months.rows.map((row) => row[0].text).at(-1)).toBe('Oct');
    expect(view.months.rows).toHaveLength(10);
  });
});

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

  it('rounds active time to whole hours as the terminal’s Hours does', () => {
    const hours = (activeMs: number) =>
      defined(buildWrappedView(withEnvelope('wrapped', { year: 2026, activeMs }))).facts.find(
        (fact) => fact.label === 'Active time',
      )?.value;

    // 1h 30m rounds up; the client's own duration would print `1h 30m`.
    expect(hours(5_400_000)).toBe('2h');
    expect(hours(1_000)).toBe('<1h');
    expect(hours(0)).toBe('0h');
    expect(hours(4_000 * 3_600_000)).toBe('4,000h');
  });

  it('reads zeros and dashes, never NaN, when the recap leaves its figures out', () => {
    const view = defined(
      buildWrappedView(
        withEnvelope('wrapped', {
          year: 2026,
          activeDays: 1,
          topModels: [{}],
          // A month key the page cannot name shows as written.
          monthlyIntensity: [{ month: '2026-00' }],
          busiestDay: {},
        }),
      ),
    );
    const shown = JSON.stringify(view);

    expect(view.lede.map((part) => part.text).join('')).toBe(
      '0 tokens across 1 active day in 2026.',
    );
    expect(shown).not.toMatch(/NaN|undefined/u);
    expect(view.topLists[0].items[0]).toMatchObject({ name: '—', tokens: '0', share: 0 });
    expect(texts(view.months.rows[0])).toEqual(['2026-00', '0', '—']);
    expect(view.facts.find((fact) => fact.label === 'Busiest day')).toEqual({
      label: 'Busiest day',
      value: '—',
      detail: '0 tokens',
    });
    // No timezone in the recap: the file's own.
    expect(view.note).toBe(
      'From wrapped for 2026, in Europe/Paris. The controls below do not change it.',
    );
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

describe('efficiency lead', () => {
  it('heads the lead with the totals and lists each period with the total under a rule', () => {
    const view = defined(
      buildEfficiencyView(withEnvelope('efficiency', readGolden('efficiency-monthly'))),
    );

    expect(view.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Commits', '1'],
      ['Lines changed', '2'],
      // efficiency-monthly.txt: $/Commit $0.0014, $/1k Lines $0.7121.
      ['Cost per commit', '$0.0014'],
      ['Cost per 1k lines', '$0.7121'],
      // The terminal's full-width table: Tokens/Commit with two decimals.
      ['Tokens per commit', '195.00'],
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
      '$0.0014',
      '$0.7121',
      '195.00',
    ]);
    expect(texts(table.foot[0])[0]).toBe('Total');
  });

  it('says what the commits cost in a sentence', () => {
    const one = defined(
      buildEfficiencyView(withEnvelope('efficiency', readGolden('efficiency-monthly'))),
    );
    const rows = record(readGolden('efficiency-monthly')).rows as Record<string, unknown>[];
    const total = { ...defined(rows.at(-1)), commitCount: 4, costUsd: 2, usdPerCommit: 0.5 };
    const four = defined(
      buildEfficiencyView(withEnvelope('efficiency', { grouping: 'period', rows: [total] })),
    );
    const none = defined(
      buildEfficiencyView(
        withEnvelope('efficiency', {
          grouping: 'period',
          rows: [{ ...total, commitCount: 0, costIncomplete: true }],
        }),
      ),
    );

    expect(ledeText(one)).toBe('1 commit for $0.00 and 195.00 tokens.');
    expect(ledeText(four)).toBe('4 commits for $2.00: $0.5000 a commit, 195.00 tokens a commit.');
    expect(ledeText(none)).toBe('No commits in this window, against ~$2.00 of usage.');
    expect(none.facts.slice(2, 4).map((fact) => fact.value)).toEqual(['~$0.5000', '~$0.7121']);
  });

  it('keeps the fraction of a token per commit that --json and the terminal print', () => {
    const rows = record(readGolden('efficiency-monthly')).rows as Record<string, unknown>[];
    const total = { ...defined(rows.at(-1)), commitCount: 5, tokensPerCommit: 4699.8 };
    const view = defined(
      buildEfficiencyView(withEnvelope('efficiency', { grouping: 'period', rows: [total] })),
    );

    expect(ledeFigures(view).at(-1)).toBe('4,699.80');
    expect(view.facts.at(-1)?.value).toBe('4,699.80');
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

describe('optimize lead', () => {
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

    // optimize-monthly.txt: ALL baseline cost ~$0.62, best candidate unavailable.
    expect(view.facts.map((fact) => [fact.label, fact.value])).toEqual([
      ['Provider', 'openai'],
      ['Baseline cost', '~$0.62'],
      ['Best candidate', 'Unavailable'],
    ]);
    expect(view.facts[2].detail).toBe('baseline is a lower bound; cache writes priced as input');
    expect(ledeText(view)).toBe(
      'Baseline cost ~$0.62. No candidate has a savings figure: baseline is a lower bound; cache writes priced as input.',
    );
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
    expect(ledeText(view)).toBe(
      'On cheaper the same tokens would have cost $0.00 instead of ~$0.62: $0.60 saved (96.0%).',
    );
    expect(ledeFigures(view)).toEqual(['cheaper', '$0.00', '~$0.62', '$0.60', '96.0%']);

    const dearer = defined(
      buildOptimizeView(withEnvelope('optimize', [...rows.slice(0, 1), rows[3]])),
    );
    expect(ledeText(dearer)).toBe(
      'On dearer the same tokens would have cost $0.00 instead of ~$0.62: $0.10 more (16.0%).',
    );
    expect(texts(view.tables[0].foot[2])[4]).toBe('−$0.10');
  });

  it('says so when the window had no usage to compare', () => {
    const view = defined(buildOptimizeView(withEnvelope('optimize', [])));

    expect(view.tables).toEqual([]);
    expect(ledeText(view)).toBe('No usage data found.');
    expect(view.note).toMatch(/^No usage to compare in this window\./u);
  });

  it('claims no comparison for a window whose rows hold no usage', () => {
    // optimize-empty-window.txt: the provider, then "No usage data found …", and nothing else.
    const empty = golden
      .filter((row) => row.periodKey === 'ALL')
      .map((row): Record<string, unknown> =>
        row.rowType === 'baseline'
          ? { ...row, totalTokens: 0, baselineCostUsd: 0, baselineCostIncomplete: false }
          : { ...row, hypotheticalCostUsd: 0, savingsUsd: 0, savingsRatio: undefined, notes: [] },
      );
    const view = defined(buildOptimizeView(withEnvelope('optimize', empty)));

    expect(ledeText(view)).toBe('No usage data found.');
    expect(view.facts).toEqual([{ label: 'Provider', value: 'openai' }]);
    expect(view.tables).toEqual([]);

    // Unpriced usage alone is still usage, as the terminal counts it.
    const unpriced = empty.map((row) =>
      row.rowType === 'baseline' ? { ...row, baselineCostIncomplete: true } : row,
    );
    expect(ledeText(defined(buildOptimizeView(withEnvelope('optimize', unpriced))))).toMatch(
      /^On gpt-4\.1 /u,
    );
  });
});

describe('compare lead', () => {
  const report = withEnvelope('compare', readGolden('compare-by-repo'));
  const view = defined(buildCompareView(report, createLabels(report, undefined)));

  it('says the current cost and its change against the baseline in words', () => {
    // compare.txt: Cost ~$0.06 now, $0.00 before, ~+$0.06, +6,251.6%.
    const plain = withEnvelope('compare', readGolden('compare'));
    const lede = defined(buildCompareView(plain, createLabels(plain, undefined)));

    expect(ledeText(lede)).toBe(
      '~$0.06 spent in 1 Jun 2026 – 30 Jun 2026, up ~$0.06 (+6,251.6%) against 1 May 2026 – 31 May 2026.',
    );
    expect(ledeFigures(lede)).toEqual(['~$0.06', '~$0.06', '+6,251.6%']);
  });

  it('says down, or the same, when the cost fell or held', () => {
    const data = record(readGolden('compare-by-repo'));
    const withCost = (delta: number) =>
      withEnvelope('compare', {
        ...data,
        totals: (data.totals as Record<string, unknown>[]).map((row) =>
          row.key === 'costUsd' ? { ...row, delta, deltaRatio: undefined } : row,
        ),
      });
    const fell = withCost(-0.5);
    const held = withCost(0);

    expect(ledeText(defined(buildCompareView(fell, createLabels(fell, undefined))))).toBe(
      '$0.09 spent in 1 Jun 2026 – 30 Jun 2026, down $0.50 against 1 May 2026 – 31 May 2026.',
    );
    expect(ledeText(defined(buildCompareView(held, createLabels(held, undefined))))).toBe(
      '$0.09 spent in 1 Jun 2026 – 30 Jun 2026, the same as in 1 May 2026 – 31 May 2026.',
    );
  });

  it('leads with tokens in a file without cost', () => {
    const data = record(readGolden('compare-by-repo'));
    const noCost = withEnvelope('compare', {
      ...data,
      totals: (data.totals as Record<string, unknown>[]).filter((row) => row.key !== 'costUsd'),
    });
    const lede = defined(buildCompareView(noCost, createLabels(noCost, undefined)));

    expect(ledeText(lede)).toBe(
      '33,740 tokens in 1 Jun 2026 – 30 Jun 2026, up 30,990 (+1,126.9%) against 1 May 2026 – 31 May 2026.',
    );
  });

  it('leads with tokens, never "the same", when the cost change is unknown', () => {
    // compare --json with unpriced current events: no current cost and no cost delta.
    const data = record(readGolden('compare-by-repo'));
    const unpricedCost = (rows: Record<string, unknown>[]) =>
      rows.map((row) =>
        row.key === 'costUsd'
          ? { ...row, current: undefined, delta: undefined, deltaRatio: undefined, baseline: 0 }
          : row,
      );
    const unpriced = withEnvelope('compare', {
      ...data,
      totals: unpricedCost(data.totals as Record<string, unknown>[]),
    });
    const unpricedView = defined(buildCompareView(unpriced, createLabels(unpriced, undefined)));
    const lede = ledeText(unpricedView);

    expect(unpricedView.facts[0]).toEqual({
      label: 'Cost change',
      value: '—',
      detail: 'change unknown · — against $0.00',
    });

    expect(lede).toBe(
      '33,740 tokens in 1 Jun 2026 – 30 Jun 2026, up 30,990 (+1,126.9%) against 1 May 2026 – 31 May 2026.',
    );

    const costOnly = withEnvelope('compare', {
      ...data,
      totals: unpricedCost(
        (data.totals as Record<string, unknown>[]).filter((row) => row.key !== 'totalTokens'),
      ),
    });
    expect(ledeText(defined(buildCompareView(costOnly, createLabels(costOnly, undefined))))).toBe(
      '— spent in 1 Jun 2026 – 30 Jun 2026, the change against 1 May 2026 – 31 May 2026 is unknown.',
    );
  });

  it('says a percentage is left out only when the baseline was zero and the current was not', () => {
    // A 0 → 0 row keeps its 0.0%, as --json's deltaRatio 0 and the terminal's 0%.
    const data = record(readGolden('compare-by-repo'));
    const empty = withEnvelope('compare', {
      ...data,
      totals: (data.totals as Record<string, unknown>[]).map((row) => ({
        ...row,
        current: 0,
        baseline: 0,
        delta: 0,
        deltaRatio: 0,
      })),
    });
    const flat = defined(buildCompareView(empty, createLabels(empty, undefined)));

    expect(tableOf(flat, 'Totals').rows.every((cells) => cells[4].text === '0.0%')).toBe(true);
    expect(flat.note).toMatch(
      /left out when the baseline was zero and the current value was not\./u,
    );
  });

  it('states the cost, token and event changes', () => {
    expect(view.facts).toEqual([
      { label: 'Cost change', value: '+$0.08', detail: '+655.1% · $0.09 against $0.01' },
      {
        label: 'Total tokens change',
        value: '+30,990',
        detail: '+1,126.9% · 33,740 against 2,750',
      },
      { label: 'Events change', value: '+8', detail: '+400.0% · 10 against 2' },
    ]);
  });

  it('signs every change and leaves out a percentage the CLI could not compute', () => {
    const totals = tableOf(view, 'Totals');
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
    const lead = defined(buildCompareView(plain, createLabels(plain, undefined)));
    const cost = defined(tableOf(lead, 'Totals').rows.find((cells) => cells[0].text === 'Cost'));

    expect(texts(cost)).toEqual(['Cost', '~$0.06', '$0.00', '~+$0.06', '+6,251.6%']);
    expect(lead.tables.map((table) => table.title)).toEqual([
      'Biggest changes (cost)',
      'Totals',
      'By source (cost)',
    ]);
  });

  it('ranks the biggest changes across sources and projects, leaving out unchanged rows', () => {
    const movers = tableOf(view, 'Biggest changes (cost)');
    const deltas = (rows: unknown, kind: string) =>
      (rows as Record<string, unknown>[]).map((row) => ({
        name: `${String(row[kind === 'source' ? 'source' : 'project'])} (${kind})`,
        size: Math.abs(Number(record(row.delta).costUsd ?? 0)),
      }));
    const data = record(readGolden('compare-by-repo'));
    const expected = [...deltas(data.sources, 'source'), ...deltas(data.projects, 'project')]
      .filter((row) => row.size > 0)
      .sort((left, right) => right.size - left.size)
      .slice(0, 5)
      .map((row) => row.name);

    expect(movers.rows.map((cells) => cells[0].text)).toEqual(expected);
    expect(texts(movers.rows[0])).toEqual([
      'claude (source)',
      '$0.06',
      '$0.01',
      '+$0.05',
      '+627.8%',
    ]);
  });

  it('breaks down by source and project by cost, and by tokens in a file without cost', () => {
    expect(view.tables.map((table) => table.title)).toEqual([
      'Biggest changes (cost)',
      'Totals',
      'By source (cost)',
      'By project (cost)',
    ]);
    expect(texts(tableOf(view, 'By project (cost)').rows[0])).toEqual([
      'b/api',
      '$0.03',
      '$0.00',
      '+$0.03',
      '—',
    ]);

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
      projects: (data.projects as Record<string, unknown>[]).map(dropCost),
    });
    const lead = defined(buildCompareView(noCost, createLabels(noCost, undefined)));
    const tokens = tableOf(lead, 'By source (tokens)');

    expect(texts(tokens.rows[0])).toEqual(['claude', '20,050', '1,500', '+18,550', '+1,236.7%']);
    expect(tableOf(lead, 'Biggest changes (tokens)').rows[0][0].text).toBe('claude (source)');
  });

  it('hides project names the file does not hold while Hide names is on', () => {
    const hidden = createLabels(report, createMaskSource(report)());
    const lead = defined(buildCompareView(report, hidden));
    const projects = tableOf(lead, 'By project (cost)').rows.map((cells) => cells[0].text);
    const movers = tableOf(lead, 'Biggest changes (cost)').rows.map((cells) => cells[0].text);

    expect(projects).not.toContain('b/api');
    expect(new Set(projects)).toEqual(new Set([HIDDEN_LABEL, '(unattributed)']));
    expect(movers.join(' ')).not.toMatch(/[ab]\/api/u);
  });

  it('says the controls below do not change it', () => {
    expect(view.note).toContain('The controls below do not change it.');
  });
});

/** The summary golden's data with `change` applied to its month-to-date period. */
function summaryWith(
  change: (month: Record<string, unknown>, data: Record<string, unknown>) => void,
): ShareReport {
  const data = structuredClone(record(readGolden('summary')));
  const month = defined(
    (data.periods as Record<string, unknown>[]).find((period) => period.key === 'monthToDate'),
  );
  change(month, data);
  return withEnvelope('summary', data);
}

const summaryOf = (report: ShareReport) =>
  defined(buildSummaryView(report, createLabels(report, undefined)));

describe('summary lead', () => {
  const report = withEnvelope('summary', readGolden('summary'));
  const view = summaryOf(report);

  it('says this month’s cost and where it is heading, as summary.txt does', () => {
    // summary.txt: Month to date ~$0.06; "On pace for ~$0.09 this month".
    expect(ledeText(view)).toBe(
      '~$0.06 spent this month so far, on pace for ~$0.09 by month end (day 21 of 30).',
    );
    expect(ledeFigures(view)).toEqual(['~$0.06', '~$0.09']);
  });

  it('lists the periods with their cost against the days before, tokens and top source', () => {
    const [periods] = view.tables;

    expect(periods.columns.map((column) => column.label)).toEqual([
      'Period',
      'Cost',
      'Previous',
      'Change',
      'Tokens',
      'Top source',
    ]);
    // summary.json: today $0 against $0.00142425 the day before; the last 7 days $0.06142425
    // against $0.001227; the month $0.0635 against $0 in the 21 days before it.
    expect(periods.rows.map(texts)).toEqual([
      ['Today', '$0.00', '$0.00', '−100.0%', '0', '—'],
      ['Last 7 days', '~$0.06', '$0.00', '+4,906.1%', '1,190', 'kilocode (~49%)'],
      ['Month to date', '~$0.06', '$0.00', '—', '1,585', 'kilocode (~47%)'],
    ]);
    expect(periods.rows[1][3].note).toBe('Against 8 Jun 2026 – 14 Jun 2026');
    expect(view.tables).toHaveLength(1);
  });

  it('keeps the table without the change for a file from before it or without cost', () => {
    const labels = (report: ShareReport) =>
      summaryOf(report).tables[0].columns.map((column) => column.label);
    const withoutPrevious = withEnvelope('summary', {
      ...record(readGolden('summary')),
      periods: (record(readGolden('summary')).periods as Record<string, unknown>[]).map(
        (period) => {
          const copy = { ...period };
          delete copy.previous;
          return copy;
        },
      ),
    });
    const withoutCost = withEnvelope('summary', {
      ...record(readGolden('summary')),
      periods: (record(readGolden('summary')).periods as Record<string, unknown>[]).map(
        (period) => {
          const totals = { ...record(period.totals) };
          delete totals.costUsd;
          return { ...period, totals };
        },
      ),
    });

    expect(labels(withoutPrevious)).toEqual(['Period', 'Cost', 'Tokens', 'Top source']);
    expect(labels(withoutCost)).toEqual(['Period', 'Cost', 'Tokens', 'Top source']);
  });

  it('states the cache savings and the past year’s streaks and best day', () => {
    // summary.txt: caching saved ~$0.00; streaks 1 and 2 days; best day 2026-06-15 · ~$0.06 ·
    // 970 tokens; 10 active days since 2025-06-16.
    expect(view.month.map((fact) => [fact.label, fact.value])).toEqual([
      ['Cache savings', '~$0.00'],
    ]);
    expect(view.activity).toEqual([
      { label: 'Current streak', value: '1 day' },
      { label: 'Longest streak', value: '2 days' },
      { label: 'Best day', value: '15 Jun 2026', detail: '~$0.06 · 970 tokens' },
      { label: 'Active days', value: '10', detail: 'Since 16 Jun 2025' },
    ]);
  });

  it('draws the past year’s 53 weeks at the CLI’s heat levels', () => {
    const days = record(readGolden('summary')).activity as { days: { level: number }[] };

    expect(view.calendar.days).toHaveLength(days.days.length);
    expect(view.calendar.weeks).toBe(53);
    expect(view.calendar.days.map((day) => day.level)).toEqual(days.days.map((day) => day.level));
    expect(view.calendar.summary).toBe('Daily tokens since 16 Jun 2025: usage on 10 days of 371.');
  });

  it('lists the calendar’s days with usage as its table', () => {
    // summary.txt: 10 active days; best day 15 Jun 2026 with 970 tokens.
    const { table } = view.calendar;

    expect(table.columns.map((column) => column.label)).toEqual(['Day', 'Tokens']);
    expect(table.rows).toHaveLength(10);
    expect(table.rows.map(texts)).toContainEqual(['15 Jun 2026', '970']);
  });

  it('words the budget as the terminal does', () => {
    const budget = (budgetUsd: number) =>
      summaryOf(
        summaryWith((_, data) => {
          record(data.monthEnd).budgetUsd = budgetUsd;
        }),
      ).month[0];
    const unknown = summaryOf(
      summaryWith((month, data) => {
        record(data.monthEnd).budgetUsd = 1;
        delete record(month.totals).costUsd;
      }),
    ).month[0];

    expect(budget(1)).toEqual({
      label: 'Monthly budget',
      value: '$1.00',
      detail: 'Within budget: ~$0.06 spent',
    });
    expect(budget(0.05).detail).toBe('Over budget: ~$0.06 spent');
    expect(budget(0.08).detail).toBe('On pace to exceed it by ~$0.01');
    expect(unknown.detail).toBe('This month’s cost is unknown (no pricing for its usage)');
  });

  it('splits the month by machine, by cost or by tokens, with names hidden on request', () => {
    const machines = [
      { machine: 'desk', totalTokens: 1000, costUsd: 0.05 },
      { machine: 'local', totalTokens: 585, costUsd: 0.01, costIncomplete: true },
    ];
    const split = summaryWith((month) => {
      month.machines = machines;
    });
    const byCost = defined(summaryOf(split).tables[1]);
    const noCost = summaryWith((month, data) => {
      month.machines = machines.map(({ machine, totalTokens }) => ({ machine, totalTokens }));
      delete record(month.totals).costUsd;
      delete record(data.monthEnd).projectedCostUsd;
    });
    const byTokens = defined(summaryOf(noCost).tables[1]);
    const hidden = defined(buildSummaryView(split, createLabels(split, createMaskSource(split)())))
      .tables[1];

    expect(byCost.title).toBe('This month by machine');
    expect(byCost.rows.map(texts)).toEqual([
      ['desk', '$0.05', '~79%'],
      ['local', '~$0.01', '~16%'],
    ]);
    expect(byTokens.columns[1].label).toBe('Tokens');
    expect(byTokens.rows.map(texts)).toEqual([
      ['desk', '1K', '63%'],
      ['local', '585', '37%'],
    ]);
    expect(hidden.rows.map((cells) => cells[0].text)).toEqual([HIDDEN_LABEL, 'local']);
    expect(ledeText(summaryOf(noCost))).toBe('1.59K tokens this month so far.');
  });

  it('shows no machine split for one machine, and says when the month has no usage', () => {
    const one = summaryWith((month) => {
      month.machines = [{ machine: 'local', totalTokens: 1585, costUsd: 0.06 }];
    });
    const empty = summaryWith((month) => {
      record(month.totals).events = 0;
    });

    expect(summaryOf(one).tables).toHaveLength(1);
    expect(ledeText(summaryOf(empty))).toBe('No usage this month so far.');
    expect(view.note).toBe(
      'From the summary command on 21 Jun 2026, in UTC. The controls below do not change it.',
    );
  });
});

const trendsOf = (name: string, labels?: (report: ShareReport) => ShareLabels) => {
  const report = withEnvelope('trends', readGolden(name));
  return defined(buildTrendsView(report, (labels ?? ((r) => createLabels(r, undefined)))(report)));
};

describe('trends lead', () => {
  const view = trendsOf('trends-tokens');

  it('says the total, the daily average and the peak as trends-tokens.txt prints them', () => {
    // trends-tokens.txt: "Total: 2.17K | Avg: 12/day | Peak: 970 (Jun 15)" over 181 days.
    expect(ledeText(view)).toBe(
      '2.17K tokens over 181 days, 12 a day on average, peaking at 970 on 15 Jun 2026.',
    );
    expect(ledeFigures(view)).toEqual(['2.17K', '12', '970']);
    expect(view.title).toBe('Daily token usage');
  });

  it('draws one bar a day, the peak full height and marked, the average as a rule', () => {
    const chart = defined(view.chart);
    const series = record(record(readGolden('trends-tokens')).totalSeries);
    const buckets = series.buckets as { date: string; value: number }[];
    const peaks = chart.bars.filter((bar) => bar.peak);
    const tallest = Math.max(...chart.bars.map((bar) => bar.height));

    expect(chart.bars).toHaveLength(181);
    expect(peaks).toHaveLength(1);
    expect(peaks[0].height).toBe(tallest);
    expect(peaks[0].label).toBe('15 Jun 2026: 970 tokens');
    expect(chart.peak).toBe('Peak 970 on 15 Jun 2026');
    expect(chart.average.label).toBe('Average 12/day');
    // The rule sits where the average's bar would end.
    const average = Number(record(series.summary).average);
    expect(chart.height - chart.average.y).toBeCloseTo((average / 970) * (tallest + 0), 5);
    expect(chart.dates).toEqual(['1 Jan 2026', '1 Apr 2026', '30 Jun 2026']);
    expect(chart.bars.map((bar) => bar.height > 0)).toEqual(buckets.map((b) => b.value > 0));
    expect(chart.bars.every((bar) => bar.x >= 0 && bar.x + bar.width <= chart.width)).toBe(true);
  });

  it('lists the days with usage as the chart’s table', () => {
    expect(view.days.rows).toHaveLength(10);
    expect(view.days.rows.map(texts)).toContainEqual(['15 Jun 2026', '970']);
  });

  it('totals each source, and each project with names hidden on request', () => {
    const bySource = trendsOf('trends-by-source');
    const byRepo = trendsOf('trends-by-repo', (report) =>
      createLabels(report, createMaskSource(report)()),
    );

    expect(bySource.tables[0].title).toBe('By source');
    expect(texts(bySource.tables[0].rows[0])).toEqual(['pi', '180', '0.994', '150', '4 Jan 2026']);
    expect(byRepo.tables[0].title).toBe('By project');
    expect(new Set(byRepo.tables[0].rows.map((cells) => cells[0].text))).toEqual(
      new Set([HIDDEN_LABEL, '(unattributed)']),
    );
    expect(view.tables).toEqual([]);
  });

  it('prints active hours as durations and cost in dollars', () => {
    const active = trendsOf('trends-active-hours');
    const cost = trendsOf('trends-by-repo');

    expect(ledeText(active)).toBe(
      '15m active over 181 days, <1m a day on average, peaking at 5m on 3 Jun 2026.',
    );
    expect(ledeText(cost)).toBe(
      '$0.09 over 3 days, $0.03 a day on average, peaking at $0.09 on 15 Jun 2026.',
    );
  });

  it('rounds active minutes as the terminal does', () => {
    const data = structuredClone(record(readGolden('trends-active-hours')));
    const series = record(data.totalSeries);
    const [bucket] = series.buckets as Record<string, unknown>[];
    series.buckets = [{ ...bucket, value: 119_000 }];
    series.summary = {
      ...record(series.summary),
      total: 119_000,
      average: 119_000,
      observedDayCount: 1,
      peak: { date: bucket.date, value: 119_000 },
    };
    const report = withEnvelope('trends', data);
    const view = defined(buildTrendsView(report, createLabels(report, undefined)));

    // trends --metric active-hours: 119,000 ms prints as 2m.
    expect(ledeFigures(view)).toEqual(['2m', '2m', '2m']);
    expect(ledeText(view)).toMatch(/^2m active over 1 day, /u);
  });

  it('marks lower-bound costs and draws nothing for a series of zeros', () => {
    const data = structuredClone(record(readGolden('trends-by-repo')));
    const series = record(data.totalSeries);
    record(series.summary).incomplete = true;
    (series.buckets as Record<string, unknown>[])[1].incomplete = true;
    const report = withEnvelope('trends', data);
    const lowerBound = defined(buildTrendsView(report, createLabels(report, undefined)));

    expect(ledeFigures(lowerBound)).toEqual(['~$0.09', '~$0.03', '~$0.09']);

    const empty = structuredClone(record(readGolden('trends-tokens')));
    const total = record(empty.totalSeries);
    total.buckets = (total.buckets as Record<string, unknown>[]).map((bucket) => ({
      ...bucket,
      value: 0,
    }));
    record(total.summary).observedDayCount = 0;
    const zero = withEnvelope('trends', empty);
    const none = defined(buildTrendsView(zero, createLabels(zero, undefined)));

    expect(none.chart).toBeUndefined();
    expect(ledeText(none)).toBe('No token usage in these 181 days.');

    total.buckets = (total.buckets as Record<string, unknown>[]).slice(0, 1);
    const oneDay = withEnvelope('trends', empty);
    expect(ledeText(defined(buildTrendsView(oneDay, createLabels(oneDay, undefined))))).toBe(
      'No token usage on this day.',
    );
  });
});

describe('lead tables on a narrow screen', () => {
  const kept = (table: PanelTable) =>
    table.columns.filter((column) => column.narrow !== false).map((column) => column.label);

  it('keep each row’s name and its key measures, as the explorer tables do', () => {
    const compareReport = withEnvelope('compare', readGolden('compare-by-repo'));
    const compare = defined(
      buildCompareView(compareReport, createLabels(compareReport, undefined)),
    );
    const summary = summaryOf(withEnvelope('summary', readGolden('summary')));
    const trends = trendsOf('trends-by-source');
    const efficiency = defined(
      buildEfficiencyView(withEnvelope('efficiency', readGolden('efficiency-monthly'))),
    );
    const optimize = defined(
      buildOptimizeView(withEnvelope('optimize', readGolden('optimize-monthly'))),
    );

    expect(kept(tableOf(compare, 'Totals'))).toEqual(['Metric', 'Current (2026-06)', 'Change']);
    expect(kept(tableOf(compare, 'By project (cost)'))).toEqual(['Project', 'Current', 'Change']);
    expect(kept(summary.tables[0])).toEqual(['Period', 'Cost', 'Change']);
    expect(kept(trends.tables[0])).toEqual(['Source', 'Total', 'Peak']);
    expect(kept(efficiency.tables[0])).toEqual(['Period', 'Commits', 'Cost', 'Per commit']);
    expect(kept(optimize.tables[0])).toEqual(['Period', 'Candidate', 'Savings']);
    // A dated candidate name is wide enough to push the savings off a phone screen.
    expect(optimize.tables[0].columns.filter((column) => column.wrap)).toEqual([
      { label: 'Candidate', numeric: false, wrap: true },
    ]);
  });
});
