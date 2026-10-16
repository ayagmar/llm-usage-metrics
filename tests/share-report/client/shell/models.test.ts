import { describe, expect, it } from 'vitest';

import {
  getDefaultViewState,
  type ShareReport,
  type ShareViewState,
} from '../../../../src/share-report/client/core/index.js';
import {
  countDimensionTokens,
  getCostModeOptions,
  getFilterGroups,
  getGranularityOptions,
  getStackOptions,
} from '../../../../src/share-report/client/ui/controls/model.js';
import {
  formatCompact,
  formatCost,
  formatCount,
  formatDateRange,
  formatDay,
  formatDuration,
  formatPercent,
  formatTimestamp,
  pluralize,
} from '../../../../src/share-report/client/ui/shell/format.js';
import {
  buildHeader,
  buildSummary,
  getEmptyState,
  getPanelsFor,
  type PanelPlacement,
} from '../../../../src/share-report/client/ui/shell/model.js';
import { getReportTitle } from '../../../../src/share-report/client/ui/export/share-document.js';
import {
  buildViewContext,
  createLabels,
  createMaskSource,
  type ShareViewContext,
} from '../../../../src/share-report/client/ui/state/context.js';
import {
  buildProjectTable,
  buildSessionTable,
  buildTable,
  describeOmittedSessions,
  describePage,
  TABLE_PAGE_SIZE,
} from '../../../../src/share-report/client/ui/tables/model.js';
import { HOST_TIMEZONES, loadFixtureReport, useHostTimezone } from '../core/share-fixture.js';

function contextFor(
  report: ShareReport,
  patch: Partial<ShareViewState> = {},
  hideNames = false,
): ShareViewContext {
  return buildViewContext(
    report,
    { ...getDefaultViewState(report), ...patch },
    createLabels(report, hideNames ? createMaskSource(report)() : undefined),
    'light',
  );
}

function texts(cells: { text: string }[] | undefined): string[] {
  return (cells ?? []).map((cell) => cell.text);
}

describe('formatting', () => {
  it('writes counts, compact numbers, percents and durations', () => {
    expect(formatCount(24300)).toBe('24,300');
    expect(formatCompact(24300)).toBe('24.3K');
    expect(formatCompact(11_091_300)).toBe('11.1M');
    expect(formatPercent(0.7589)).toBe('75.9%');
    expect(formatPercent(null)).toBe('—');
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration((3 * 60 + 5) * 60_000)).toBe('3h 05m');
    expect(pluralize(1, 'session')).toBe('1 session');
    expect(pluralize(1200, 'session')).toBe('1,200 sessions');
  });

  it('marks a cost some events had no price for, as the terminal does', () => {
    expect(formatCost({ kind: 'value', costUsd: 0.36, incompleteEvents: 0 })).toEqual({
      text: '$0.36',
    });
    expect(formatCost({ kind: 'value', costUsd: 0.36, incompleteEvents: 1 })).toEqual({
      text: '~$0.36',
      note: '1 event had no price, so this is a lower bound',
    });
    expect(formatCost({ kind: 'value', costUsd: null, incompleteEvents: 3 }).text).toBe('—');
    expect(formatCost({ kind: 'value', costUsd: null, incompleteEvents: 0 })).toEqual({
      text: '—',
    });
    expect(formatCost({ kind: 'unavailable' }).text).toBe('n/a');
    expect(formatCost({ kind: 'none' }).text).toBe('—');
  });

  it('writes dates from keys, with open ends spelled out', () => {
    expect(formatDay('2026-10-20')).toBe('20 Oct 2026');
    expect(formatDay('not a date')).toBe('not a date');
    expect(formatDateRange('2026-10-20', '2026-10-26')).toBe('20 Oct 2026 – 26 Oct 2026');
    expect(formatDateRange('2026-10-20', '2026-10-20')).toBe('20 Oct 2026');
    expect(formatDateRange(null, '2026-10-20')).toBe('Up to 20 Oct 2026');
    expect(formatDateRange('2026-10-20', null)).toBe('From 20 Oct 2026');
    expect(formatDateRange(null, null)).toBe('All dates');
  });

  for (const host of HOST_TIMEZONES) {
    describe(`under TZ=${host}`, () => {
      useHostTimezone(host);

      it('writes timestamps in the report timezone, not the host one', () => {
        expect(formatTimestamp('2026-10-26T22:07:00.000Z', 'Europe/Paris')).toBe(
          '2026-10-26 23:07',
        );
        expect(formatTimestamp('2026-10-25T00:30:00.000Z', 'Europe/Paris')).toBe(
          '2026-10-25 02:30',
        );
        expect(formatTimestamp('garbage', 'Europe/Paris')).toBe('—');
      });
    });
  }
});

describe('header', () => {
  const report = loadFixtureReport();

  it('names the report, its period and what the file holds', () => {
    const header = buildHeader(contextFor(report));

    expect(header.title).toBe('Daily usage');
    expect(header.period).toBe('20 Oct 2026 – 26 Oct 2026');
    expect(header.facts).toEqual([
      'File covers 29 Dec 2025 – 26 Oct 2026',
      'Times in Europe/Paris',
      'Generated 2026-10-27 09:00',
      'llm-usage-metrics 0.0.0-fixture',
    ]);
    expect(header.badges).toEqual([
      { text: 'Shows project and machine names', tone: 'notice' },
      { text: 'Hourly detail from 20 Oct 2026', tone: 'neutral' },
    ]);
  });

  it('says when the file is redacted, names are hidden, prices failed or the command filtered', () => {
    const edited = loadFixtureReport((data) => {
      data.meta.redacted = true;
      data.meta.hourlyFrom = null;
      data.meta.unavailableCostModes = ['estimated', 'both'];
      data.meta.filters = {
        sources: ['codex'],
        providers: [],
        models: [],
        machines: ['laptop'],
        repo: true,
      };
    });

    expect(buildHeader(contextFor(edited, {}, true)).badges.map((badge) => badge.text)).toEqual([
      'Redacted',
      'Names hidden on screen',
      'Generated for source codex; machine laptop; selected repositories',
      'Prices unavailable: estimated, both',
    ]);
  });

  it('hides a machine name the command filtered on while names are hidden', () => {
    const edited = loadFixtureReport((data) => {
      data.meta.filters.machines = ['laptop'];
    });

    expect(buildHeader(contextFor(edited, {}, true)).badges.map((badge) => badge.text)).toContain(
      'Generated for machine machine-1',
    );
  });

  it('says when the file holds no cost', () => {
    const noCost = loadFixtureReport((data) => {
      data.meta.costMode = null;
      data.cube.costs = {};
    });

    expect(buildHeader(contextFor(noCost)).badges.map((badge) => badge.text)).toContain(
      'No cost data',
    );
  });

  it('titles each command, and wrapped by its year', () => {
    expect(
      getReportTitle({ command: 'wrapped', window: { since: '2025-01-01', until: '2025-12-31' } }),
    ).toBe('Wrapped 2025');
    expect(getReportTitle({ command: 'wrapped', window: { since: null, until: null } })).toBe(
      'Wrapped',
    );
    expect(getReportTitle({ command: 'compare', window: { since: null, until: null } })).toBe(
      'Usage comparison',
    );
  });
});

describe('summary', () => {
  const report = loadFixtureReport();

  it('totals the opening view of the fixture', () => {
    expect(buildSummary(contextFor(report)).map(({ id, value }) => [id, value])).toEqual([
      ['tokens', '31.1K'],
      ['cost', '~$0.36'],
      ['events', '12'],
      ['active', '27m'],
      ['cache-hit', '75.9%'],
      ['cost-per-hour', '$0.80'],
    ]);
  });

  it('clips cost per active hour to hourly cells and says so', () => {
    const figures = buildSummary(contextFor(report, { since: null, until: null }));
    const perHour = figures.find((figure) => figure.id === 'cost-per-hour');

    expect(perHour?.value).toBe('$0.80');
    expect(perHour?.detail).toBe('Approximate; hourly detail from 20 Oct 2026');
  });

  it('leaves out cost figures with --no-cost', () => {
    const noCost = loadFixtureReport((data) => {
      data.meta.costMode = null;
      data.cube.costs = {};
    });

    expect(buildSummary(contextFor(noCost)).map((figure) => figure.id)).toEqual([
      'tokens',
      'events',
      'active',
      'cache-hit',
    ]);
  });

  it('shows n/a and no hourly cost when the mode had no prices', () => {
    const failed = loadFixtureReport((data) => {
      data.meta.unavailableCostModes = ['both'];
    });
    const figures = buildSummary(contextFor(failed, { costMode: 'both' }));

    expect(figures.find((figure) => figure.id === 'cost')?.value).toBe('n/a');
    expect(figures.find((figure) => figure.id === 'cost-per-hour')?.value).toBe('—');
  });
});

describe('empty states', () => {
  const report = loadFixtureReport();

  it('has none while the view has data', () => {
    expect(getEmptyState(contextFor(report))).toBeUndefined();
  });

  it('offers to clear filters when they match nothing', () => {
    expect(getEmptyState(contextFor(report, { machine: [1], project: [0] }))).toMatchObject({
      title: 'Nothing matches these filters',
      action: 'reset-filters',
    });
  });

  it('offers the opening view when the period has no usage', () => {
    expect(
      getEmptyState(contextFor(report, { since: '2026-02-01', until: '2026-02-28' })),
    ).toMatchObject({
      title: 'No usage in this period',
      action: 'reset-view',
    });
  });

  it('explains a file without usage', () => {
    const empty = loadFixtureReport((data) => {
      for (const column of Object.values(data.cube)) {
        if (Array.isArray(column)) {
          column.length = 0;
        }
      }
      data.cube.costs = {};
      data.dictionaries.periods = [];
    });

    expect(getEmptyState(contextFor(empty))).toEqual({
      title: 'No usage in this file',
      body: 'The command found no usage for 29 Dec 2025 – 26 Oct 2026. Run it again with a wider period to share one.',
    });
  });
});

describe('controls', () => {
  const report = loadFixtureReport();

  it('lists granularities with where hourly detail starts', () => {
    expect(getGranularityOptions(report).map((option) => [option.value, option.detail])).toEqual([
      ['hour', 'From 20 Oct 2026'],
      ['day', undefined],
      ['week', undefined],
      ['month', undefined],
    ]);
  });

  it('disables cost modes without prices and hides the control with --no-cost', () => {
    const failed = loadFixtureReport((data) => {
      data.meta.unavailableCostModes = ['estimated'];
      delete data.cube.costs.estimated;
    });

    expect(
      getCostModeOptions(failed).map((option) => [option.value, option.disabledReason]),
    ).toEqual([
      ['explicit', undefined],
      ['estimated', 'Prices could not be loaded'],
      ['both', undefined],
    ]);

    const noCost = loadFixtureReport((data) => {
      data.meta.costMode = null;
      data.cube.costs = {};
    });
    expect(getCostModeOptions(noCost)).toEqual([]);
  });

  it('stacks by every dimension', () => {
    expect(getStackOptions().map((option) => option.value)).toEqual([
      'source',
      'model',
      'project',
      'machine',
    ]);
  });

  it('orders filter options by tokens over the file and masks names when hidden', () => {
    const tokens = countDimensionTokens(report);
    const view = { ...getDefaultViewState(report), project: [1] };
    const groups = getFilterGroups(report, tokens, view, createLabels(report, undefined));

    expect(tokens.project).toEqual([33_900, 5_800, 1_800]);
    expect(groups.map((group) => [group.dimension, group.summary, group.filtered])).toEqual([
      ['source', 'All', false],
      ['model', 'All', false],
      ['project', 'beta', true],
      ['machine', 'All', false],
    ]);
    expect(groups[2]?.options).toEqual([
      { index: 0, label: 'alpha', selected: false },
      { index: 1, label: 'beta', selected: true },
      { index: 2, label: '(unattributed)', selected: false },
    ]);

    const hidden = getFilterGroups(
      report,
      tokens,
      { ...view, project: [0, 1] },
      createLabels(report, createMaskSource(report)()),
    );
    expect(hidden[2]?.summary).toBe('2 projects');
    expect(hidden[2]?.options.map((option) => option.label)).toEqual([
      'project-1',
      'project-2',
      '(unattributed)',
    ]);
  });

  it('offers no filter for a dimension with one label', () => {
    const single = loadFixtureReport((data) => {
      data.dictionaries.machines = ['local'];
      data.cube.machine = data.cube.machine.map(() => 0);
      data.sessions.rows.forEach((row) => {
        row.machines = [0];
      });
    });

    expect(
      getFilterGroups(
        single,
        countDimensionTokens(single),
        getDefaultViewState(single),
        createLabels(single, undefined),
      ).map((group) => group.dimension),
    ).toEqual(['source', 'model', 'project']);
  });
});

describe('tables', () => {
  const report = loadFixtureReport();

  it('lists projects in the view by cost, with a total row', () => {
    const table = buildProjectTable(contextFor(report), 0);

    expect(table.columns.map((column) => column.label)).toEqual([
      'Project',
      'Tokens',
      'Input',
      'Output',
      'Cache read',
      'Cache hit',
      'Events',
      'Active',
      'Cost',
    ]);
    expect(table.columns.find((column) => column.key === 'cost')?.sort).toBe('descending');
    expect(
      table.rows.map((row) => [row.cells[0]?.text, row.cells.at(-1)?.text, row.drill]),
    ).toEqual([
      ['alpha', '$0.25', 0],
      ['(unattributed)', '$0.08', 2],
      ['beta', '~$0.03', 1],
    ]);
    expect(texts(table.total)).toEqual([
      'All 3 projects',
      '31,100',
      '6,600',
      '1,700',
      '22,300',
      '75.9%',
      '12',
      '27m',
      '~$0.36',
    ]);
  });

  it('sorts by label with masked names when names are hidden', () => {
    const table = buildProjectTable(
      contextFor(report, { sort: { key: 'label', direction: 'asc' } }, true),
      0,
    );

    expect(table.rows.map((row) => row.cells[0]?.text)).toEqual([
      '(unattributed)',
      'project-1',
      'project-2',
    ]);
  });

  it('drops the cost column with --no-cost', () => {
    const noCost = loadFixtureReport((data) => {
      data.meta.costMode = null;
      data.cube.costs = {};
    });

    expect(
      buildProjectTable(contextFor(noCost), 0).columns.map((column) => column.key),
    ).not.toContain('cost');
  });

  it('keeps the label, tokens and cost on narrow screens, events without a cost', () => {
    const narrow = (table: { columns: { key: string; narrow: boolean }[] }) =>
      table.columns.filter((column) => column.narrow).map((column) => column.key);
    const noCost = loadFixtureReport((data) => {
      data.meta.costMode = null;
      data.cube.costs = {};
    });

    expect(narrow(buildProjectTable(contextFor(report), 0))).toEqual([
      'label',
      'totalTokens',
      'cost',
    ]);
    expect(narrow(buildSessionTable(contextFor(report), 0, 0))).toEqual([
      'label',
      'totalTokens',
      'cost',
    ]);
    expect(narrow(buildProjectTable(contextFor(noCost), 0))).toEqual([
      'label',
      'totalTokens',
      'eventCount',
    ]);
    expect(narrow(buildSessionTable(contextFor(noCost), 0, 0))).toEqual([
      'label',
      'totalTokens',
      'eventCount',
    ]);
  });

  it('drills into a project: its sessions, newest first by last activity, and what was left out', () => {
    const table = buildSessionTable(
      contextFor(report, {
        since: null,
        until: null,
        sort: { key: 'lastActivity', direction: 'desc' },
      }),
      0,
      0,
    );

    expect(table.caption).toBe('Sessions in alpha');
    expect(table.rows.map((row) => texts(row.cells.slice(0, 5)))).toEqual([
      ['codex · 2026-10-26 23:05', 'codex', 'gpt-5-codex', 'local', '2026-10-26 23:07'],
      ['claude · 2026-10-20 09:10', 'claude', 'claude-sonnet-4-5', 'local', '2026-10-20 09:25'],
    ]);
    expect(
      table.columns.filter((column) => column.sortKey === undefined).map((column) => column.key),
    ).toEqual(['source', 'models', 'machines']);
    expect(table.omittedSessions).toBe(4);
    expect(describeOmittedSessions(table.omittedSessions)).toBe(
      '4 older sessions of this project are not embedded in the file.',
    );
    expect(describeOmittedSessions(1)).toBe(
      '1 older session of this project is not embedded in the file.',
    );
    expect(describeOmittedSessions(0)).toBeUndefined();
  });

  it('shows the drill-down the view names, else the projects', () => {
    expect(buildTable(contextFor(report), 0).kind).toBe('projects');
    expect(buildTable(contextFor(report, { drill: 1 }), 0).kind).toBe('sessions');
  });

  it('says so when a drilled project has no session in the view', () => {
    const table = buildSessionTable(
      contextFor(report, { since: '2026-02-01', until: '2026-02-02' }),
      1,
      0,
    );

    expect(table.rows).toEqual([]);
    expect(table.empty).toBe('No embedded session of beta was active in this view.');
  });

  it('pages long tables and keeps the page in range', () => {
    const wide = loadFixtureReport((data) => {
      const projects = Array.from(
        { length: 45 },
        (_, index) => `p${String(index).padStart(2, '0')}`,
      );
      const cube = data.cube;
      data.dictionaries.projects = projects;

      for (let index = cube.period.length; index < 45; index += 1) {
        for (const column of [
          'period',
          'source',
          'model',
          'machine',
          'inputTokens',
          'outputTokens',
          'reasoningTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'totalTokens',
          'eventCount',
          'activeMs',
        ] as const) {
          cube[column].push(cube[column][3]);
        }

        for (const mode of ['explicit', 'estimated', 'both'] as const) {
          cube.costs[mode]?.costUsd.push(0.01);
          cube.costs[mode]?.incompleteEvents.push(0);
        }
      }

      cube.project = cube.period.map((_, cell) => cell);
    });
    const context = contextFor(wide, {
      since: null,
      until: null,
      sort: { key: 'label', direction: 'asc' },
    });
    const last = buildProjectTable(context, 99);

    expect(last.page).toBe(2);
    expect(last.pageCount).toBe(3);
    expect(last.rows).toHaveLength(45 - 2 * TABLE_PAGE_SIZE);
    expect(last.rows[0]?.cells[0]?.text).toBe('p40');
    expect(describePage(last)).toBe('41–45 of 45');
    expect(describePage(buildProjectTable(context, 0))).toBe('1–20 of 45');
    expect(describePage({ ...last, rowCount: 0 })).toBe('0 rows');
  });
});

describe('panel placement', () => {
  const report = loadFixtureReport();

  it('keeps the panels that apply to the file, by placement and in list order', () => {
    const panel = (id: string, placement: PanelPlacement, applies: boolean) => ({
      id,
      placement,
      appliesTo: () => applies,
    });
    const placed = getPanelsFor(report, [
      panel('a', 'section', true),
      panel('b', 'recap', true),
      panel('c', 'section', false),
      panel('d', 'section', true),
    ]);

    expect(placed.recap.map((entry) => entry.id)).toEqual(['b']);
    expect(placed.section.map((entry) => entry.id)).toEqual(['a', 'd']);
  });
});
