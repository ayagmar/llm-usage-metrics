// The efficiency lead: cost and tokens against git outcomes, from the embedded
// `efficiency --json` data. Fixed at generation: the page's filters do not change it.

import { NO_VALUE, type ShareReport } from '../../core/index.js';
import {
  figure,
  FIXED_NOTE,
  formatCountOrNone,
  formatEnvelopeCost,
  getEnvelopeData,
  isRecord,
  LOWER_BOUND_NOTE,
  readNumber,
  readRecords,
  readString,
  words,
  type LedePart,
  type PanelCell,
  type PanelColumn,
  type PanelFact,
  type PanelView,
} from './model.js';
import { formatInteger } from '../../../../render/format-number.js';

const NOTE = `From the efficiency command: commits and lines come from the git history of the repository it ran in. ${FIXED_NOTE}`;

function costCell(row: Record<string, unknown>, key: string): PanelCell {
  return formatEnvelopeCost(readNumber(row, key), row.costIncomplete === true);
}

let rateFormatter: Intl.NumberFormat | undefined;

/** A cost per commit or per 1k lines with four decimals, as the terminal prints it. */
function rateCell(row: Record<string, unknown>, key: string): PanelCell {
  const value = readNumber(row, key);

  if (value === undefined) {
    return { text: NO_VALUE };
  }

  rateFormatter ??= new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
  const text = rateFormatter.format(value);
  return row.costIncomplete === true ? { text: `~${text}`, note: LOWER_BOUND_NOTE } : { text };
}

let decimalFormatter: Intl.NumberFormat | undefined;

/** Tokens per commit with two decimals, as the terminal prints it: `4,699.80`. */
function formatTokenRate(value: number | undefined): string {
  if (value === undefined) {
    return NO_VALUE;
  }

  decimalFormatter ??= new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return decimalFormatter.format(value);
}

function rowCells(row: Record<string, unknown>, bySource: boolean): PanelCell[] {
  const period = readString(row, 'periodKey') ?? NO_VALUE;
  const lead: PanelCell[] =
    row.rowType === 'grand_total'
      ? bySource
        ? [{ text: 'Total' }, { text: '' }]
        : [{ text: 'Total' }]
      : bySource
        ? [{ text: period }, { text: readString(row, 'source') ?? NO_VALUE }]
        : [{ text: period }];

  return [
    ...lead,
    { text: formatCountOrNone(readNumber(row, 'commitCount')) },
    { text: formatCountOrNone(readNumber(row, 'linesAdded')) },
    { text: formatCountOrNone(readNumber(row, 'linesDeleted')) },
    { text: formatCountOrNone(readNumber(row, 'totalTokens')) },
    costCell(row, 'costUsd'),
    rateCell(row, 'usdPerCommit'),
    rateCell(row, 'usdPer1kLinesChanged'),
    { text: formatTokenRate(readNumber(row, 'tokensPerCommit')) },
  ];
}

function buildFacts(total: Record<string, unknown>): PanelFact[] {
  const added = readNumber(total, 'linesAdded') ?? 0;
  const deleted = readNumber(total, 'linesDeleted') ?? 0;

  return [
    { label: 'Commits', value: formatCountOrNone(readNumber(total, 'commitCount')) },
    {
      label: 'Lines changed',
      value: formatCountOrNone(readNumber(total, 'linesChanged')),
      detail: `${formatInteger(added)} added, ${formatInteger(deleted)} deleted`,
    },
    { label: 'Cost per commit', value: rateCell(total, 'usdPerCommit').text },
    { label: 'Cost per 1k lines', value: rateCell(total, 'usdPer1kLinesChanged').text },
    { label: 'Tokens per commit', value: formatTokenRate(readNumber(total, 'tokensPerCommit')) },
  ];
}

/** `3 commits for $0.12: $0.0400 a commit, 1,200.00 tokens a commit.`, or one commit's cost and tokens. */
function buildLede(total: Record<string, unknown>): LedePart[] {
  const commits = readNumber(total, 'commitCount') ?? 0;
  const cost = costCell(total, 'costUsd').text;

  if (commits === 0) {
    return [words('No commits in this window, against '), figure(cost), words(' of usage.')];
  }

  const tokens = figure(formatTokenRate(readNumber(total, 'tokensPerCommit')));

  if (commits === 1) {
    return [
      figure('1'),
      words(' commit for '),
      figure(cost),
      words(' and '),
      tokens,
      words(' tokens.'),
    ];
  }

  return [
    figure(formatInteger(commits)),
    words(' commits for '),
    figure(cost),
    words(': '),
    figure(rateCell(total, 'usdPerCommit').text),
    words(' a commit, '),
    tokens,
    words(' tokens a commit.'),
  ];
}

/** The efficiency panel, or undefined when the file's efficiency data cannot be read. */
export function buildEfficiencyView(report: ShareReport): PanelView | undefined {
  const data = getEnvelopeData(report, 'efficiency');

  if (!isRecord(data) || !Array.isArray(data.rows)) {
    return undefined;
  }

  const bySource = data.grouping === 'source';
  const rows = readRecords(data.rows);
  const total = rows.find((row) => row.rowType === 'grand_total');
  const body = rows.filter((row) => row.rowType !== 'grand_total');
  const columns: PanelColumn[] = [
    { label: 'Period', numeric: false },
    ...(bySource ? [{ label: 'Source', numeric: false }] : []),
    { label: 'Commits', numeric: true },
    // A phone keeps commits, cost and cost per commit.
    { label: 'Lines added', numeric: true, narrow: false },
    { label: 'Lines deleted', numeric: true, narrow: false },
    { label: 'Tokens', numeric: true, narrow: false },
    { label: 'Cost', numeric: true },
    { label: 'Per commit', numeric: true },
    { label: 'Per 1k lines', numeric: true, narrow: false },
    { label: 'Tokens per commit', numeric: true, narrow: false },
  ];

  return {
    lede: total ? buildLede(total) : [],
    facts: total ? buildFacts(total) : [],
    tables:
      body.length === 0
        ? []
        : [
            {
              title: bySource ? 'By period and source' : 'By period',
              columns,
              rows: body.map((row) => rowCells(row, bySource)),
              foot: total ? [rowCells(total, bySource)] : [],
            },
          ],
    note: body.length === 0 ? `No period in this window had a commit. ${NOTE}` : NOTE,
  };
}
