// The efficiency panel: cost and tokens against git outcomes, from the embedded
// `efficiency --json` data. Fixed at generation: the page's filters do not change it.

import { NO_VALUE, type ShareReport } from '../../core/index.js';
import { formatCount } from '../shell/format.js';
import {
  formatCountOrNone,
  formatEnvelopeCost,
  getEnvelopeData,
  isRecord,
  readNumber,
  readRecords,
  readString,
  type PanelCell,
  type PanelColumn,
  type PanelFact,
  type PanelView,
} from './model.js';

const NOTE =
  'From the efficiency command: commits and lines come from the git history of the repository it ran in. The controls above do not change it.';

function costCell(row: Record<string, unknown>, key: string): PanelCell {
  return formatEnvelopeCost(readNumber(row, key), row.costIncomplete === true);
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
    costCell(row, 'usdPerCommit'),
    costCell(row, 'usdPer1kLinesChanged'),
    { text: formatCountOrNone(readNumber(row, 'tokensPerCommit')) },
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
      detail: `${formatCount(added)} added, ${formatCount(deleted)} deleted`,
    },
    { label: 'Cost per commit', value: costCell(total, 'usdPerCommit').text },
    { label: 'Cost per 1k lines', value: costCell(total, 'usdPer1kLinesChanged').text },
    { label: 'Tokens per commit', value: formatCountOrNone(readNumber(total, 'tokensPerCommit')) },
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
    { label: 'Lines added', numeric: true },
    { label: 'Lines deleted', numeric: true },
    { label: 'Tokens', numeric: true },
    { label: 'Cost', numeric: true },
    { label: 'Per commit', numeric: true },
    { label: 'Per 1k lines', numeric: true },
    { label: 'Tokens per commit', numeric: true },
  ];

  return {
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
