// The compare lead: the current window against the baseline in words, the biggest movers,
// then the command's tables, from the embedded `compare --json` data. Fixed at generation:
// the page's filters do not change it.

import { NO_VALUE, type ShareReport } from '../../core/index.js';
import type { ShareLabels } from '../state/context.js';
import { formatCount, formatDateRange } from '../shell/format.js';
import {
  figure,
  FIXED_NOTE,
  formatEnvelopeCost,
  formatSignedCost,
  formatSignedCount,
  formatSignedRatio,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
  words,
  type LedePart,
  type PanelCell,
  type PanelFact,
  type PanelTable,
  type PanelView,
} from './model.js';

type Side = { title: string; range: string };

function readSide(data: Record<string, unknown>, key: 'current' | 'baseline'): Side | undefined {
  const side = data[key];
  const window = isRecord(side) && isRecord(side.window) ? side.window : undefined;

  if (!window) {
    return undefined;
  }

  const since = readString(window, 'since') ?? null;
  const until = readString(window, 'until') ?? null;
  return { title: readString(window, 'label') ?? NO_VALUE, range: formatDateRange(since, until) };
}

/** One metric row of `totals`: integers as counts, `usd` as cost with its lower-bound marks. */
function metricCells(row: Record<string, unknown>): PanelCell[] {
  const usd = row.valueType === 'usd';
  const value = (key: string, incomplete: boolean): PanelCell =>
    usd
      ? formatEnvelopeCost(readNumber(row, key), incomplete)
      : { text: formatValue(readNumber(row, key)) };

  return [
    { text: readString(row, 'label') ?? readString(row, 'key') ?? NO_VALUE },
    value('current', row.currentCostIncomplete === true),
    value('baseline', row.baselineCostIncomplete === true),
    usd
      ? formatSignedCost(readNumber(row, 'delta'), row.deltaCostIncomplete === true)
      : { text: formatSignedCount(readNumber(row, 'delta')) },
    { text: formatSignedRatio(readNumber(row, 'deltaRatio')) },
  ];
}

function formatValue(value: number | undefined): string {
  return value === undefined ? NO_VALUE : formatCount(value);
}

type Breakdown = {
  /** `Source` or `Project`. */
  kind: string;
  rows: Record<string, unknown>[];
  nameOf: (row: Record<string, unknown>) => string;
};

function sideOf(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  return isRecord(value) ? value : {};
}

/** Breakdowns compare cost, as the terminal shows them, or tokens when the file has no cost. */
function breakdownMetric(rows: Record<string, unknown>[]): 'costUsd' | 'totalTokens' {
  return rows.some((row) => readNumber(sideOf(row, 'current'), 'costUsd') !== undefined)
    ? 'costUsd'
    : 'totalTokens';
}

/** A breakdown row's cells: name, current, baseline, change and change in percent. */
function breakdownCells(
  row: Record<string, unknown>,
  metric: 'costUsd' | 'totalTokens',
  name: string,
): PanelCell[] {
  const delta = sideOf(row, 'delta');
  const amount = (record: Record<string, unknown>): PanelCell =>
    metric === 'costUsd'
      ? formatEnvelopeCost(readNumber(record, metric), record.costIncomplete === true)
      : { text: formatValue(readNumber(record, metric)) };

  return [
    { text: name },
    amount(sideOf(row, 'current')),
    amount(sideOf(row, 'baseline')),
    metric === 'costUsd'
      ? formatSignedCost(readNumber(delta, metric), delta.costIncomplete === true)
      : { text: formatSignedCount(readNumber(delta, metric)) },
    { text: formatSignedRatio(readNumber(sideOf(row, 'deltaRatio'), metric)) },
  ];
}

const CHANGE_COLUMNS = [
  { label: 'Current', numeric: true },
  { label: 'Baseline', numeric: true },
  { label: 'Change', numeric: true },
  { label: 'Change %', numeric: true },
];

function breakdownTable({ kind, rows, nameOf }: Breakdown): PanelTable {
  const metric = breakdownMetric(rows);

  return {
    title: `By ${kind.toLowerCase()} (${metric === 'costUsd' ? 'cost' : 'tokens'})`,
    columns: [{ label: kind, numeric: false }, ...CHANGE_COLUMNS],
    rows: rows.map((row) => breakdownCells(row, metric, nameOf(row))),
    foot: [],
  };
}

const MOVERS = 5;

/**
 * The rows that changed most across sources and projects, by the size of their change in the
 * breakdowns' metric; ties keep the command's order. Rows that did not change are left out.
 */
function moversTable(breakdowns: Breakdown[]): PanelTable | undefined {
  const metric = breakdownMetric(breakdowns.flatMap((breakdown) => breakdown.rows));
  const ranked = breakdowns
    .flatMap((breakdown) =>
      breakdown.rows.map((row) => ({
        breakdown,
        row,
        size: Math.abs(readNumber(sideOf(row, 'delta'), metric) ?? 0),
      })),
    )
    .filter((mover) => mover.size > 0)
    .sort((left, right) => right.size - left.size)
    .slice(0, MOVERS);

  if (ranked.length === 0) {
    return undefined;
  }

  return {
    title: `Biggest changes (${metric === 'costUsd' ? 'cost' : 'tokens'})`,
    columns: [{ label: 'Name', numeric: false }, ...CHANGE_COLUMNS],
    rows: ranked.map(({ breakdown, row }) =>
      breakdownCells(row, metric, `${breakdown.nameOf(row)} (${breakdown.kind.toLowerCase()})`),
    ),
    foot: [],
  };
}

/** The cost, token and event changes; the lede names both windows. */
function buildFacts(totals: Record<string, unknown>[]): PanelFact[] {
  const facts: PanelFact[] = [];

  for (const key of ['costUsd', 'totalTokens', 'events']) {
    const row = totals.find((entry) => entry.key === key);

    if (row) {
      const [label, now, then, change, ratio] = metricCells(row);
      const percent = ratio.text === NO_VALUE ? 'nothing before' : ratio.text;
      facts.push({
        label: `${label.text} change`,
        value: change.text,
        detail: `${percent} · ${now.text} against ${then.text}`,
      });
    }
  }

  return facts;
}

/**
 * `~$0.06 spent in 1 Jun 2026 – 30 Jun 2026, up ~$0.06 (+6,251.6%) against 1 May 2026 –
 * 31 May 2026.`: cost when the file has it, else tokens, in the terminal's figures.
 */
function buildLede(current: Side, baseline: Side, totals: Record<string, unknown>[]): LedePart[] {
  const row =
    totals.find((entry) => entry.key === 'costUsd') ??
    totals.find((entry) => entry.key === 'totalTokens');

  if (!row) {
    return [];
  }

  const [, now, , change, ratio] = metricCells(row);
  const delta = readNumber(row, 'delta') ?? 0;
  const lede = [
    figure(now.text),
    words(`${row.key === 'costUsd' ? ' spent' : ' tokens'} in ${current.range}, `),
  ];

  if (delta === 0) {
    return [...lede, words(`the same as in ${baseline.range}.`)];
  }

  // The sign is in the words, so the figure drops it.
  const size = change.text.replace(/^(~?)[+−]/u, '$1');
  return [
    ...lede,
    words(delta > 0 ? 'up ' : 'down '),
    figure(size),
    ...(ratio.text === NO_VALUE ? [] : [words(' ('), figure(ratio.text), words(')')]),
    words(` against ${baseline.range}.`),
  ];
}

/** The compare panel, or undefined when the file's compare data cannot be read. */
export function buildCompareView(report: ShareReport, labels: ShareLabels): PanelView | undefined {
  const data = getEnvelopeData(report, 'compare');

  if (!isRecord(data)) {
    return undefined;
  }

  const current = readSide(data, 'current');
  const baseline = readSide(data, 'baseline');

  if (!current || !baseline) {
    return undefined;
  }

  const totals = readRecords(data.totals);
  const listed: Breakdown[] = [
    {
      kind: 'Source',
      rows: readRecords(data.sources),
      nameOf: (row) => readString(row, 'source') ?? NO_VALUE,
    },
    {
      kind: 'Project',
      rows: readRecords(data.projects),
      nameOf: (row) => labels.project(readString(row, 'project') ?? NO_VALUE),
    },
  ];
  const breakdowns = listed.filter((breakdown) => breakdown.rows.length > 0);
  const movers = moversTable(breakdowns);
  const tables: PanelTable[] = [
    ...(movers ? [movers] : []),
    {
      title: 'Totals',
      columns: [
        { label: 'Metric', numeric: false },
        { label: `Current (${current.title})`, numeric: true },
        { label: `Baseline (${baseline.title})`, numeric: true },
        { label: 'Change', numeric: true },
        { label: 'Change %', numeric: true },
      ],
      rows: totals.map(metricCells),
      foot: [],
    },
  ];

  tables.push(...breakdowns.map(breakdownTable));

  return {
    lede: buildLede(current, baseline, totals),
    facts: buildFacts(totals),
    tables,
    note: `From the compare command. A change in percent is left out when the baseline was zero. ${FIXED_NOTE}`,
  };
}
