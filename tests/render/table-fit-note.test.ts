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
});
