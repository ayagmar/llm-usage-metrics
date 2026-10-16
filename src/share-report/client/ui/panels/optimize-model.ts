// The optimize lead: what the same tokens would have cost on each candidate model, from the
// embedded `optimize --json` rows. Fixed at generation: the page's filters do not change it.

import { NO_VALUE, type ShareReport } from '../../core/index.js';
import { formatPercent } from '../shell/format.js';
import {
  figure,
  FIXED_NOTE,
  formatEnvelopeCost,
  formatSignedCost,
  getEnvelopeData,
  readNumber,
  readRecords,
  readString,
  words,
  type LedePart,
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

const NOTE = `From the optimize command. Savings are the baseline cost minus the hypothetical one: positive means the candidate is cheaper. ${FIXED_NOTE}`;

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

/** The whole-window candidate with the largest savings, if any candidate has a savings figure. */
function findBest(candidates: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return candidates
    .filter((row) => readNumber(row, 'savingsUsd') !== undefined)
    .reduce<Record<string, unknown> | undefined>(
      (current, row) =>
        current === undefined ||
        (readNumber(row, 'savingsUsd') ?? 0) > (readNumber(current, 'savingsUsd') ?? 0)
          ? row
          : current,
      undefined,
    );
}

/** Why no candidate has a savings figure: the whole-window notes, in words. */
function describeUnavailable(candidates: Record<string, unknown>[]): string {
  const reasons = [...new Set(candidates.map(describeNotes).filter((text) => text !== ''))];
  return reasons.length === 0 ? 'a baseline or candidate price is missing' : reasons.join('; ');
}

/** As the CLI decides a period has usage: tokens, a logged cost or unpriced events. */
function hasBaselineUsage(row: Record<string, unknown>): boolean {
  return (
    (readNumber(row, 'totalTokens') ?? 0) > 0 ||
    row.baselineCostIncomplete === true ||
    (readNumber(row, 'baselineCostUsd') ?? 0) > 0
  );
}

function baselineCost(baseline: Record<string, unknown> | undefined): string {
  return baseline
    ? formatEnvelopeCost(
        readNumber(baseline, 'baselineCostUsd'),
        baseline.baselineCostIncomplete === true,
      ).text
    : NO_VALUE;
}

function providerFact(providers: string[]): PanelFact {
  return { label: 'Provider', value: providers.length === 0 ? NO_VALUE : providers.join(', ') };
}

function buildFacts(
  providers: string[],
  baseline: Record<string, unknown> | undefined,
  best: Record<string, unknown> | undefined,
  candidates: Record<string, unknown>[],
): PanelFact[] {
  const facts: PanelFact[] = [
    providerFact(providers),
    { label: 'Baseline cost', value: baselineCost(baseline), detail: 'The whole window' },
  ];

  if (!best) {
    facts.push({
      label: 'Best candidate',
      value: 'Unavailable',
      detail: describeUnavailable(candidates),
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

/**
 * `On gpt-4.1-mini the same tokens would have cost $0.10 instead of $0.62: $0.52 saved (84.0%).`,
 * or why no candidate can be ranked.
 */
function buildLede(
  baseline: Record<string, unknown> | undefined,
  best: Record<string, unknown> | undefined,
  candidates: Record<string, unknown>[],
): LedePart[] {
  if (candidates.length === 0) {
    return [];
  }

  if (!best) {
    return [
      words('Baseline cost '),
      figure(baselineCost(baseline)),
      words(`. No candidate has a savings figure: ${describeUnavailable(candidates)}.`),
    ];
  }

  const savings = readNumber(best, 'savingsUsd') ?? 0;
  const ratio = readNumber(best, 'savingsRatio');
  const hypothetical = formatEnvelopeCost(
    readNumber(best, 'hypotheticalCostUsd'),
    best.hypotheticalCostIncomplete === true,
  ).text;

  return [
    words('On '),
    figure(readString(best, 'candidateModel') ?? NO_VALUE),
    words(' the same tokens would have cost '),
    figure(hypothetical),
    words(' instead of '),
    figure(baselineCost(baseline)),
    words(': '),
    figure(formatEnvelopeCost(Math.abs(savings)).text),
    words(savings >= 0 ? ' saved' : ' more'),
    ...(ratio === undefined
      ? []
      : [words(' ('), figure(formatPercent(Math.abs(ratio))), words(')')]),
    words('.'),
  ];
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

  const best = findBest(totals);

  // The terminal prints only the provider and this line when no period has usage.
  if (![...baselines.values()].some(hasBaselineUsage)) {
    return {
      lede: [words('No usage data found.')],
      facts: [providerFact(providers)],
      tables: [],
      note: `No usage to compare in this window. ${NOTE}`,
    };
  }

  return {
    lede: buildLede(totalBaseline, best, totals),
    facts: buildFacts(providers, totalBaseline, best, totals),
    tables:
      candidates.length === 0
        ? []
        : [
            {
              title: 'By period',
              columns: [
                { label: 'Period', numeric: false },
                // A phone keeps the period, the candidate and its savings; a dated model name
                // wraps rather than pushing the savings out of view.
                { label: 'Candidate', numeric: false, wrap: true },
                { label: 'Hypothetical cost', numeric: true, narrow: false },
                { label: 'Baseline cost', numeric: true, narrow: false },
                { label: 'Savings', numeric: true },
                { label: 'Savings %', numeric: true, narrow: false },
                { label: 'Notes', numeric: false, narrow: false },
              ],
              rows: candidates.filter((row) => !isTotal(row)).map(cells),
              foot: totals.map(cells),
            },
          ],
    note: candidates.length === 0 ? `No usage to compare in this window. ${NOTE}` : NOTE,
  };
}
