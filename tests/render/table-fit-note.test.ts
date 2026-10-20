import { describe, expect, it } from 'vitest';

import { describeTableFit } from '../../src/render/table-fit-note.js';

describe('describeTableFit', () => {
  const unchanged = { abbreviatedTokens: false, hiddenHeaders: [], stacked: false };

  it('says nothing when the table is shown in full', () => {
    expect(describeTableFit(unchanged)).toBeUndefined();
  });

  it('names one hidden column without a dangling "and"', () => {
    expect(describeTableFit({ ...unchanged, hiddenHeaders: ['Models'] })).toBe(
      'Fitted the table to the terminal: hid Models. Widen the terminal or use --json for full detail.',
    );
  });

  it('lists every change in order, joining the hidden columns with commas and "and"', () => {
    expect(
      describeTableFit({
        abbreviatedTokens: true,
        hiddenHeaders: ['Models', 'Duration', 'Last Activity'],
        shortenedModelNames: true,
        stacked: false,
      }),
    ).toBe(
      'Fitted the table to the terminal: abbreviated token counts, hid Models, Duration and Last Activity, shortened model names. Widen the terminal or use --json for full detail.',
    );
  });

  it('says rows were listed even when the list keeps every column', () => {
    expect(describeTableFit({ ...unchanged, stacked: true })).toBe(
      'Listed rows instead of a table to fit the terminal. Widen the terminal to see the table.',
    );
  });

  it('names abbreviated counts and shortened names that are not tokens or models', () => {
    expect(describeTableFit({ ...unchanged, abbreviatedCounts: true, shortenedNames: true })).toBe(
      'Fitted the table to the terminal: abbreviated counts, shortened long names. Widen the terminal or use --json for full detail.',
    );
  });

  it('gives a report with several tables one note, naming each hidden column once', () => {
    expect(
      describeTableFit(
        { ...unchanged, abbreviatedTokens: true, hiddenHeaders: ['Baseline', 'Δ%'] },
        { ...unchanged, hiddenHeaders: ['Δ%', 'Baseline'] },
      ),
    ).toBe(
      'Fitted the tables to the terminal: abbreviated token counts, hid Baseline and Δ%. Widen the terminal or use --json for full detail.',
    );
  });

  it('says "in some tables" when another table still shows a hidden column', () => {
    expect(describeTableFit(unchanged, { ...unchanged, hiddenHeaders: ['Rank'] })).toBe(
      'Fitted the tables to the terminal: hid Rank in some tables. Widen the terminal or use --json for full detail.',
    );
    expect(describeTableFit(unchanged, unchanged)).toBeUndefined();
  });

  it('says rows were listed when several tables became lists', () => {
    expect(describeTableFit({ ...unchanged, stacked: true }, { ...unchanged, stacked: true })).toBe(
      'Listed rows instead of tables to fit the terminal. Widen the terminal to see the tables.',
    );
  });

  it('does not say rows were listed instead of tables when only one table became a list', () => {
    expect(
      describeTableFit({ ...unchanged, abbreviatedTokens: true }, { ...unchanged, stacked: true }),
    ).toBe(
      'Fitted the tables to the terminal: abbreviated token counts, listed rows where no table fit. Widen the terminal or use --json for full detail.',
    );
  });
});
