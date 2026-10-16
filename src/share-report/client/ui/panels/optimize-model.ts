// The optimize panel: what the same tokens would have cost on each candidate model, from the
// embedded `optimize --json` rows. Fixed at generation: the page's filters do not change it.

import { NO_VALUE, type ShareReport } from '../../core/index.js';
import { formatPercent } from '../shell/format.js';
import {
  formatEnvelopeCost,
  formatSignedCost,
  getEnvelopeData,
  readNumber,
  readRecords,
  readString,
  type PanelCell,
  type PanelFact,
  type PanelView,
} from './model.js';

/** The CLI's note codes, in words. */
const NOTE_TEXT: Record<string, string> = {
  baseline_incomplete: 'baseline is a lower bound',
  baseline_tokens_missing: 'baseline tokens missing',
  cache_write_priced_as_input: 'cache writes priced as input',
  missing_pricing: 'no price for the candidate',
  usage_buckets_missing: 'token split missing',
};

const TOTAL_PERIOD = 'ALL';

const NOTE =
  'From the optimize command. Savings are the baseline cost minus the hypothetical one: positive means the candidate is cheaper. The controls above do not change it.';

function describeNotes(row: Record<string, unknown>): string {
  const notes = Array.isArray(row.notes)
    ? row.notes.filter((note): note is string => typeof note === 'string')
    : [];
  return notes.length === 0 ? '' : notes.map((note) => NOTE_TEXT[note] ?? note).join('; ');
}

function rowKey(row: Record<string, unknown>): string {
  return `${readString(row, 'periodKey') ?? ''}\u0000${readString(row, 'provider') ?? ''}`;
}

function candidateCells(
  candidate: Record<string, unknown>,
  baseline: Record<string, unknown> | undefined,
): PanelCell[] {
  const period = readString(candidate, 'periodKey') ?? NO_VALUE;
  const ratio = readNumber(candidate, 'savingsRatio');

  return [
    { text: period === TOTAL_PERIOD ? 'Total' : period },
    { text: readString(candidate, 'candidateModel') ?? NO_VALUE },
    formatEnvelopeCost(
      readNumber(candidate, 'hypotheticalCostUsd'),
      candidate.hypotheticalCostIncomplete === true,
    ),
    baseline
      ? formatEnvelopeCost(
          readNumber(baseline, 'baselineCostUsd'),
          baseline.baselineCostIncomplete === true,
        )
      : { text: NO_VALUE },
    formatSignedCost(readNumber(candidate, 'savingsUsd')),
    { text: ratio === undefined ? NO_VALUE : formatPercent(ratio) },
    { text: describeNotes(candidate) },
  ];
}

function buildFacts(
  providers: string[],
  baseline: Record<string, unknown> | undefined,
  candidates: Record<string, unknown>[],
): PanelFact[] {
  const priced = candidates.filter((row) => readNumber(row, 'savingsUsd') !== undefined);
  const best = priced.reduce<Record<string, unknown> | undefined>(
    (current, row) =>
      current === undefined ||
      (readNumber(row, 'savingsUsd') ?? 0) > (readNumber(current, 'savingsUsd') ?? 0)
        ? row
        : current,
    undefined,
  );
  const facts: PanelFact[] = [
    { label: 'Provider', value: providers.length === 0 ? NO_VALUE : providers.join(', ') },
    {
      label: 'Baseline cost',
      value: baseline
        ? formatEnvelopeCost(
            readNumber(baseline, 'baselineCostUsd'),
            baseline.baselineCostIncomplete === true,
          ).text
        : NO_VALUE,
      detail: 'The whole window',
    },
  ];

  if (!best) {
    facts.push({
      label: 'Best candidate',
      value: 'Unavailable',
      detail: 'Missing baseline or candidate pricing',
    });
    return facts;
  }

  const ratio = readNumber(best, 'savingsRatio');
  facts.push({
    label: 'Best candidate',
    value: readString(best, 'candidateModel') ?? NO_VALUE,
    detail: `${formatSignedCost(readNumber(best, 'savingsUsd')).text} saved${ratio === undefined ? '' : ` (${formatPercent(ratio)})`}`,
  });
  return facts;
}

/** The optimize panel, or undefined when the file's optimize data cannot be read. */
export function buildOptimizeView(report: ShareReport): PanelView | undefined {
  const data = getEnvelopeData(report, 'optimize');

  if (!Array.isArray(data)) {
    return undefined;
  }

  const rows = readRecords(data);
  const baselines = new Map(
    rows.filter((row) => row.rowType === 'baseline').map((row) => [rowKey(row), row]),
  );
  const candidates = rows.filter((row) => row.rowType === 'candidate');
  const isTotal = (row: Record<string, unknown>) => row.periodKey === TOTAL_PERIOD;
  const totals = candidates.filter(isTotal);
  const providers = [
    ...new Set(
      rows.map((row) => readString(row, 'provider')).filter((value) => value !== undefined),
    ),
  ];
  const totalBaseline = [...baselines.values()].find(isTotal);
  const cells = (row: Record<string, unknown>) => candidateCells(row, baselines.get(rowKey(row)));

  return {
    facts: buildFacts(providers, totalBaseline, totals),
    tables:
      candidates.length === 0
        ? []
        : [
            {
              title: 'By period',
              columns: [
                { label: 'Period', numeric: false },
                { label: 'Candidate', numeric: false },
                { label: 'Hypothetical cost', numeric: true },
                { label: 'Baseline cost', numeric: true },
                { label: 'Savings', numeric: true },
                { label: 'Savings %', numeric: true },
                { label: 'Notes', numeric: false },
              ],
              rows: candidates.filter((row) => !isTotal(row)).map(cells),
              foot: totals.map(cells),
            },
          ],
    note: candidates.length === 0 ? `No usage to compare in this window. ${NOTE}` : NOTE,
  };
}
