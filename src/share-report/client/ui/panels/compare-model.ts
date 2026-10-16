// The compare panel: the current window against the baseline, from the embedded
// `compare --json` data. Fixed at generation: the page's filters do not change it.

import { NO_VALUE, type ShareReport } from '../../core/index.js';
import type { ShareLabels } from '../state/context.js';
import { formatCount, formatDateRange } from '../shell/format.js';
import {
  formatEnvelopeCost,
  formatSignedCost,
  formatSignedCount,
  formatSignedRatio,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
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

/** Breakdown rows by cost, as the terminal shows them, or by tokens when the file has no cost. */
function breakdownTable(
  title: string,
  nameLabel: string,
  rows: Record<string, unknown>[],
  nameOf: (row: Record<string, unknown>) => string,
): PanelTable {
  const byCost = rows.some(
    (row) => isRecord(row.current) && readNumber(row.current, 'costUsd') !== undefined,
  );
  const metric = byCost ? 'costUsd' : 'totalTokens';
  const side = (row: Record<string, unknown>, key: string): Record<string, unknown> => {
    const value = row[key];
    return isRecord(value) ? value : {};
  };
  const amount = (record: Record<string, unknown>): PanelCell =>
    byCost
      ? formatEnvelopeCost(readNumber(record, metric), record.costIncomplete === true)
      : { text: formatValue(readNumber(record, metric)) };

  return {
    title: `${title} (${byCost ? 'cost' : 'tokens'})`,
    columns: [
      { label: nameLabel, numeric: false },
      { label: 'Current', numeric: true },
      { label: 'Baseline', numeric: true },
      { label: 'Change', numeric: true },
      { label: 'Change %', numeric: true },
    ],
    rows: rows.map((row) => {
      const delta = side(row, 'delta');
      return [
        { text: nameOf(row) },
        amount(side(row, 'current')),
        amount(side(row, 'baseline')),
        byCost
          ? formatSignedCost(readNumber(delta, metric), delta.costIncomplete === true)
          : { text: formatSignedCount(readNumber(delta, metric)) },
        { text: formatSignedRatio(readNumber(side(row, 'deltaRatio'), metric)) },
      ];
    }),
    foot: [],
  };
}

function buildFacts(current: Side, baseline: Side, totals: Record<string, unknown>[]): PanelFact[] {
  const facts: PanelFact[] = [
    { label: 'Current', value: current.title, detail: current.range },
    { label: 'Baseline', value: baseline.title, detail: baseline.range },
  ];

  for (const key of ['totalTokens', 'costUsd']) {
    const row = totals.find((entry) => entry.key === key);

    if (row) {
      const [label, , , change, ratio] = metricCells(row);
      facts.push({ label: `${label.text} change`, value: change.text, detail: ratio.text });
    }
  }

  return facts;
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
  const sources = readRecords(data.sources);
  const projects = readRecords(data.projects);
  const tables: PanelTable[] = [
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

  if (sources.length > 0) {
    tables.push(
      breakdownTable(
        'By source',
        'Source',
        sources,
        (row) => readString(row, 'source') ?? NO_VALUE,
      ),
    );
  }

  if (projects.length > 0) {
    tables.push(
      breakdownTable('By project', 'Project', projects, (row) =>
        labels.project(readString(row, 'project') ?? NO_VALUE),
      ),
    );
  }

  return {
    facts: buildFacts(current, baseline, totals),
    tables,
    note: 'From the compare command. A change in percent is left out when the baseline was zero. The controls above do not change it.',
  };
}
