import { describe, expect, it } from 'vitest';

import {
  getDefaultViewState,
  type ShareReport,
  type ShareViewState,
} from '../../../../src/share-report/client/core/index.js';
import { CHART_MODELS } from '../../../../src/share-report/client/ui/charts/models.js';
import type { ChartView, SvgNode } from '../../../../src/share-report/client/ui/charts/svg.js';
import {
  buildViewContext,
  createLabels,
  createMaskSource,
  type ShareViewContext,
} from '../../../../src/share-report/client/ui/state/context.js';
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

function chart(id: string): (typeof CHART_MODELS)[number] {
  const model = CHART_MODELS.find((entry) => entry.id === id);

  if (!model) {
    throw new Error(`No chart ${id}`);
  }

  return model;
}

function nodes(node: SvgNode | undefined): SvgNode[] {
  return node === undefined
    ? []
    : [node, ...node.children.flatMap((child) => (typeof child === 'string' ? [] : nodes(child)))];
}

/** Every text in the drawing: labels, captions and tooltips. */
function texts(node: SvgNode | undefined): string[] {
  return nodes(node).flatMap((entry) =>
    entry.children.filter((child): child is string => typeof child === 'string'),
  );
}

/** Everything a reader sees: the drawing's words, the message, notes and table. */
function allWords(view: ChartView): string {
  return [
    view.description,
    view.message ?? '',
    ...view.notes,
    ...texts(view.svg),
    view.table?.caption ?? '',
    ...(view.table?.columns.map((column) => column.label) ?? []),
    ...(view.table?.rows.flat() ?? []),
    ...(view.table?.total ?? []),
  ].join('\n');
}

function viewBoxOf(view: ChartView): [number, number, number, number] {
  return String(view.svg?.attrs.viewBox).split(' ').map(Number) as [number, number, number, number];
}

const WIDTHS = [300, 640, 1300];

describe('every chart', () => {
  const report = loadFixtureReport();

  for (const width of WIDTHS) {
    it(`draws the fixture inside its viewBox at ${width}px, with a table equivalent`, () => {
      for (const model of CHART_MODELS) {
        const view = model.build(contextFor(report), width);
        const [x, y, boxWidth, boxHeight] = viewBoxOf(view);

        expect(view.svg, model.id).toBeDefined();
        expect([x, y, boxWidth], model.id).toEqual([0, 0, width]);
        expect(view.table?.rows.length, model.id).toBeGreaterThan(0);
        expect(view.description.length, model.id).toBeGreaterThan(10);

        for (const node of nodes(view.svg)) {
          expect(node.attrs.style, model.id).toBeUndefined();

          for (const name of ['x', 'y', 'width', 'height'] as const) {
            const value = node.attrs[name];
            expect(
              typeof value === 'number' ? Number.isFinite(value) : true,
              `${model.id} ${node.tag} ${name}`,
            ).toBe(true);
          }

          if (node.tag === 'rect' && typeof node.attrs.x === 'number') {
            expect(node.attrs.x, model.id).toBeGreaterThanOrEqual(-0.01);
            expect(node.attrs.x + Number(node.attrs.width), model.id).toBeLessThanOrEqual(
              width + 0.01,
            );
            expect(Number(node.attrs.y) + Number(node.attrs.height), model.id).toBeLessThanOrEqual(
              boxHeight + 0.01,
            );
          }
        }
      }
    });
  }

  it('use pattern ids that no other chart on the page uses', () => {
    const ids = CHART_MODELS.flatMap((model) =>
      nodes(model.build(contextFor(report), 640).svg).flatMap((node) =>
        typeof node.attrs.id === 'string' ? [node.attrs.id] : [],
      ),
    );

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('show masked names in the drawing and the table while names are hidden', () => {
    const real = ['alpha', 'beta', 'laptop'];

    for (const stackBy of ['project', 'machine'] as const) {
      for (const model of CHART_MODELS) {
        const words = allWords(model.build(contextFor(report, { stackBy }, true), 640));

        for (const name of real) {
          expect(words, `${model.id} by ${stackBy}`).not.toMatch(new RegExp(`\\b${name}\\b`, 'u'));
        }
      }
    }

    const shown = allWords(chart('projects').build(contextFor(report), 640));
    expect(shown).toContain('alpha');
  });

  it('say why there is no cost when the file was made with --no-cost', () => {
    const noCost = loadFixtureReport((data) => {
      data.meta.costMode = null;
      data.cube.costs = {};
    });

    for (const id of ['cost-over-time', 'cost-per-active-hour']) {
      const view = chart(id).build(contextFor(noCost), 640);
      expect(view.svg, id).toBeUndefined();
      expect(view.message, id).toMatch(/--no-cost/u);
    }

    // The other charts still draw, with tokens only.
    const projects = chart('projects').build(contextFor(noCost), 640);
    expect(projects.table?.columns.map((column) => column.label)).toEqual([
      'Project',
      'Tokens',
      'Share',
    ]);
    expect(chart('model-mix').build(contextFor(noCost), 640).description).not.toMatch(/cost/u);
    expect(
      chart('blocks')
        .build(contextFor(noCost), 640)
        .table?.columns.map((column) => column.label),
    ).toEqual(['Start', 'Blocks', 'Tokens']);
  });

  it('say prices could not be loaded for an unavailable mode', () => {
    const failed = loadFixtureReport((data) => {
      data.meta.unavailableCostModes = ['estimated', 'both'];
      delete data.cube.costs.estimated;
      delete data.cube.costs.both;
      data.meta.costMode = 'explicit';
    });

    for (const id of ['cost-over-time', 'cost-per-active-hour']) {
      const view = chart(id).build(contextFor(failed, { costMode: 'estimated' }), 640);
      expect(view.message, id).toMatch(/Prices could not be loaded/u);
    }

    const projects = chart('projects').build(contextFor(failed, { costMode: 'estimated' }), 640);
    expect(projects.description).toMatch(/^Projects by tokens,/u);
    expect(projects.notes).toEqual(['Ranked by tokens: this view has no cost to rank by.']);
  });
});

for (const host of HOST_TIMEZONES) {
  describe(`chart numbers under TZ=${host}`, () => {
    useHostTimezone(host);
    const report = loadFixtureReport();

    it('stack cost per day by source to the summary total', () => {
      // Opening view 20–26 Oct, mode both: claude 0.20 + 0.03, codex 0.08 + 0.05.
      const view = chart('cost-over-time').build(contextFor(report), 1300);

      expect(view.table?.columns.map((column) => column.label)).toEqual([
        'Period',
        'claude',
        'codex',
        'Total',
      ]);
      expect(view.table?.rows).toEqual([
        ['20 Oct 2026', '$0.20', '$0.08', '$0.28'],
        ['25 Oct 2026', '$0.03', '$0.00', '$0.03'],
        ['26 Oct 2026', '$0.00', '$0.05', '$0.05'],
      ]);
      expect(view.table?.total).toEqual(['Total', '$0.23', '$0.13', '$0.36']);
      expect(view.notes).toContain('1 event had no price, so these costs are lower bounds.');
      expect(texts(view.svg)).toContain(
        'Cost (both) by source, per day · 20 Oct 2026 – 26 Oct 2026 · $0.36 in total',
      );
    });

    it('stack tokens by project, honour filters, and label each layer', () => {
      const view = chart('tokens-over-time').build(
        contextFor(report, { stackBy: 'project' }),
        1300,
      );

      expect(view.table?.total).toEqual(['Total', '26,000', '3,300', '1,800', '31,100']);
      expect(view.table?.columns.map((column) => column.label)).toEqual([
        'Period',
        'alpha',
        'beta',
        '(unattributed)',
        'Total',
      ]);

      // Only codex: 1,800 + 800 on 20 Oct and 1,700 on 26 Oct.
      const codex = chart('tokens-over-time').build(contextFor(report, { source: [1] }), 1300);
      expect(codex.table?.rows).toEqual([
        ['20 Oct 2026', '2,600', '2,600'],
        ['26 Oct 2026', '1,700', '1,700'],
      ]);
    });

    it('merge stacks past eight series into Other', () => {
      const many = loadFixtureReport((data) => {
        data.dictionaries.projects = Array.from({ length: 10 }, (_, index) => `p${index}`);
        data.cube.project = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => index);
        data.cube.period = [3, 3, 3, 4, 4, 5, 5, 6];
      });
      const view = chart('tokens-over-time').build(contextFor(many, { stackBy: 'project' }), 1300);

      expect(view.table?.columns.at(-2)?.label).not.toBe('Other');

      const crowded = loadFixtureReport((data) => {
        const cells = 12;
        data.dictionaries.periods = ['2026-10-21 10:00'];
        data.dictionaries.projects = Array.from({ length: cells }, (_, index) => `p${index}`);
        for (const column of [
          'source',
          'model',
          'machine',
          'inputTokens',
          'outputTokens',
          'reasoningTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'eventCount',
          'activeMs',
        ] as const) {
          data.cube[column] = new Array<number>(cells).fill(0);
        }
        data.cube.period = new Array<number>(cells).fill(0);
        data.cube.project = Array.from({ length: cells }, (_, index) => index);
        data.cube.totalTokens = Array.from({ length: cells }, (_, index) => 100 * (index + 1));
        data.cube.costs = {};
        data.meta.costMode = null;
        data.blocks.rows = [];
        data.sessions = { rows: [], omitted: [] };
      });
      const merged = chart('tokens-over-time').build(
        contextFor(crowded, { stackBy: 'project' }),
        1300,
      );

      expect(merged.table?.columns.map((column) => column.label)).toEqual([
        'Period',
        'p11',
        'p10',
        'p9',
        'p8',
        'p7',
        'p6',
        'p5',
        'p4',
        'Other',
        'Total',
      ]);
      // p0–p3: 100 + 200 + 300 + 400.
      expect(merged.table?.total?.at(-2)).toBe('1,000');
      expect(merged.notes).toContain('Other merges every project after the largest 8.');
    });

    it('roll weeks and months up on the axis and in the table', () => {
      const whole = { since: '2025-12-29', until: '2026-10-26' };
      const weeks = chart('tokens-over-time').build(
        contextFor(report, { ...whole, granularity: 'week' }),
        1300,
      );
      const months = chart('tokens-over-time').build(
        contextFor(report, { ...whole, granularity: 'month' }),
        1300,
      );

      // 31 Dec and 1 Jan fall in ISO week 1 of 2026, 5 Jan in week 2; 20–25 Oct in week 43 and
      // Monday 26 Oct opens week 44.
      expect(weeks.table?.rows.map((row) => [row[0], row.at(-1)])).toEqual([
        ['Week 1, 2026', '8,800'],
        ['Week 2, 2026', '1,600'],
        ['Week 43, 2026', '29,400'],
        ['Week 44, 2026', '1,700'],
      ]);
      expect(months.table?.rows.map((row) => [row[0], row.at(-1)])).toEqual([
        ['Dec 2025', '6,300'],
        ['Jan 2026', '4,100'],
        ['Oct 2026', '31,100'],
      ]);
      expect(texts(months.svg)).toEqual(expect.arrayContaining(['Dec 25', 'Oct 26']));
      expect(texts(weeks.svg)).toEqual(expect.arrayContaining(['W01', 'W44']));
    });

    it('merge the projects after the largest ten into Other, with how many', () => {
      const crowded = loadFixtureReport((data) => {
        data.dictionaries.projects = Array.from({ length: 12 }, (_, index) => `p${index}`);
        data.cube.project = [0, 1, 2, 3, 4, 5, 6, 7];
      });
      const twelve = loadFixtureReport((data) => {
        data.dictionaries.projects = Array.from({ length: 12 }, (_, index) => `p${index}`);
        data.dictionaries.periods = ['2026-10-21 10:00'];
        data.cube.period = new Array<number>(12).fill(0);
        for (const column of [
          'source',
          'model',
          'machine',
          'inputTokens',
          'outputTokens',
          'reasoningTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'eventCount',
          'activeMs',
        ] as const) {
          data.cube[column] = new Array<number>(12).fill(0);
        }
        data.cube.project = Array.from({ length: 12 }, (_, index) => index);
        data.cube.totalTokens = Array.from({ length: 12 }, (_, index) => 100 * (index + 1));
        data.cube.costs = {
          estimated: {
            costUsd: Array.from({ length: 12 }, (_, index) => (index === 0 ? null : 0.01 * index)),
            incompleteEvents: Array.from({ length: 12 }, (_, index) => (index === 0 ? 1 : 0)),
          },
        };
        data.meta.costMode = 'estimated';
        data.blocks.rows = [];
        data.sessions = { rows: [], omitted: [] };
      });

      expect(
        chart('projects').build(contextFor(crowded, { since: '2025-12-29' }), 1300).table?.rows,
      ).toHaveLength(8);

      const view = chart('projects').build(contextFor(twelve), 1300);
      expect(view.table?.rows).toHaveLength(11);
      // p0 (no cost, one unpriced event) and p1 ($0.01) merge into a lower bound: $0.01 of $0.66.
      expect(view.table?.rows.at(-1)).toEqual(['Other (2 projects)', '300', '~$0.01', '1.5%']);
      expect(chart('projects').build(contextFor(twelve), 300).table?.rows).toHaveLength(8);
    });

    it('rank projects by cost and give each its share', () => {
      const view = chart('projects').build(contextFor(report), 1300);

      expect(view.table?.rows).toEqual([
        ['alpha', '26,000', '$0.25', '69.4%'],
        ['(unattributed)', '1,800', '$0.08', '22.2%'],
        ['beta', '3,300', '~$0.03', '8.3%'],
      ]);
    });

    it('give each model its share of tokens and of cost', () => {
      const view = chart('model-mix').build(contextFor(report), 1300);

      expect(view.table?.rows).toEqual([
        ['claude-sonnet-4-5', '26,800', '86.2%', '$0.23', '63.9%'],
        ['gpt-5-codex', '3,500', '11.3%', '$0.13', '36.1%'],
        ['local-model.gguf', '800', '2.6%', '~$0.00', '0.0%'],
      ]);
    });

    it('break the cache hit rate per day and give the whole view', () => {
      const view = chart('cache-hit-rate').build(contextFor(report), 1300);

      // 20 Oct: 20,000 / (5,200 + 20,000 + 500); 25 Oct: 2,000 / 2,400; 26 Oct: 300 / 1,300.
      expect(view.table?.rows).toEqual([
        ['20 Oct 2026', '77.8%'],
        ['25 Oct 2026', '83.3%'],
        ['26 Oct 2026', '23.1%'],
      ]);
      expect(view.table?.total).toEqual(['Whole view', '75.9%']);
      expect(texts(view.svg)).toContain('Whole view 75.9%');
    });

    it('divide cost by active hours over hourly cells only, and say what it left out', () => {
      const view = chart('cost-per-active-hour').build(contextFor(report), 1300);

      // 20 Oct: $0.28 over 20 minutes; 25 Oct: $0.03 over 5; 26 Oct: $0.05 over 2.
      expect(view.table?.rows).toEqual([
        ['20 Oct 2026', '$0.84'],
        ['25 Oct 2026', '$0.36'],
        ['26 Oct 2026', '$1.50'],
      ]);

      const whole = chart('cost-per-active-hour').build(
        contextFor(report, { since: '2025-12-29', until: '2026-10-26' }),
        1300,
      );
      expect(whole.notes).toContain('Hourly detail from 20 Oct 2026; earlier days are left out.');
      expect(whole.table?.rows).toHaveLength(3);

      const early = chart('cost-per-active-hour').build(
        contextFor(report, { since: '2025-12-29', until: '2026-01-31' }),
        1300,
      );
      expect(early.message).toBe('This period has no hourly detail: it starts on 20 Oct 2026.');
    });

    it('place tokens by local hour and weekday, naming the busiest cell', () => {
      const view = chart('hour-weekday').build(contextFor(report), 1300);

      // 20 Oct 2026 is a Tuesday: 09:00 holds 24,300 + 1,800, 14:00 holds 800.
      expect(view.table?.rows[1]?.slice(0, 1)).toEqual(['Tue']);
      expect(view.table?.rows[1]?.[10]).toBe('26.1K');
      expect(view.table?.rows[1]?.[15]).toBe('800');
      expect(view.table?.rows[1]?.at(-1)).toBe('26,900');
      expect(texts(view.svg)).toContain('Busiest: Tue 09:00, 26.1K tokens');
      expect(nodes(view.svg).filter((node) => node.attrs.class === 'chart-peak')).toHaveLength(1);
    });

    it('clip the hour × weekday map to hourly detail and say so', () => {
      const view = chart('hour-weekday').build(
        contextFor(report, { since: '2025-12-29', until: '2026-10-26' }),
        1300,
      );

      expect(view.notes).toContain('Hourly detail from 20 Oct 2026; earlier days are left out.');
    });

    it('place blocks at the local hour they start, and say filters do not apply', () => {
      const view = chart('blocks').build(contextFor(report), 1300);

      expect(view.table?.columns.map((column) => column.label)).toEqual([
        'Start',
        'Blocks',
        'Tokens',
        'Cost (both)',
      ]);
      expect(view.table?.rows.map((row) => row[0])).toEqual([
        '20 Oct 2026 09:00',
        '26 Oct 2026 23:00',
      ]);
      expect(view.notes).not.toContain('Blocks ignore model, project and machine filters.');

      const filtered = chart('blocks').build(contextFor(report, { project: [0] }), 1300);
      expect(filtered.notes[0]).toBe('Blocks ignore model, project and machine filters.');
      expect(filtered.table?.rows).toEqual(view.table?.rows);
    });

    it('lay a long span of blocks out with days as columns', () => {
      const view = chart('blocks').build(
        contextFor(report, { since: '2026-08-01', until: '2026-10-26' }),
        1300,
      );
      const rowLabels = texts(view.svg).filter((entry) => /^\d\dh$/u.test(entry));

      expect(rowLabels).toEqual(['00h', '06h', '12h', '18h']);
    });

    it('draw hourly bars from hourly detail and note the clipping', () => {
      const view = chart('tokens-over-time').build(
        contextFor(report, { granularity: 'hour', since: '2026-10-19', until: '2026-10-20' }),
        1300,
      );

      expect(view.notes).toContain(
        'Hourly detail from 20 Oct 2026; earlier days have daily totals only.',
      );
      expect(view.table?.rows.map((row) => row[0])).toEqual([
        '20 Oct 2026 09:00',
        '20 Oct 2026 14:00',
      ]);
    });
  });
}

describe('empty views', () => {
  it('explain an empty view instead of drawing an empty frame', () => {
    const report = loadFixtureReport();
    const context = contextFor(report, { since: '2026-03-01', until: '2026-03-02' });

    for (const model of CHART_MODELS) {
      const view = model.build(context, 640);

      expect(view.svg, model.id).toBeUndefined();
      expect(view.message, model.id).toBeTruthy();
    }
  });

  it('explain a file with no span at all', () => {
    const report = loadFixtureReport((data) => {
      data.meta.window = { since: null, until: null };
      data.meta.initialView = { since: null, until: null, granularity: 'day' };
      data.dictionaries.periods = [];
      for (const key of Object.keys(data.cube) as (keyof typeof data.cube)[]) {
        if (key !== 'costs') {
          data.cube[key] = [];
        }
      }
      for (const columns of Object.values(data.cube.costs)) {
        columns.costUsd = [];
        columns.incompleteEvents = [];
      }
      data.blocks.rows = [];
      data.sessions = { rows: [], omitted: [] };
    });

    for (const model of CHART_MODELS) {
      expect(model.build(contextFor(report), 640).message, model.id).toBeTruthy();
    }
  });
});
