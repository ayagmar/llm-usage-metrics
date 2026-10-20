/** What fitting a table to the terminal changed, for the stderr note that says so. */
export type TableFitChanges = {
  /** Token counts are abbreviated, such as `24.3K` for `24,312`. */
  abbreviatedTokens: boolean;
  /** Headers of the columns the fit left out, in the order they were hidden. */
  hiddenHeaders: readonly string[];
  shortenedModelNames?: boolean;
  /** Rows are listed as label/value lines because no table step fits the terminal. */
  stacked: boolean;
};

function joinWithAnd(items: readonly string[]): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/**
 * The one wording every report uses to say a narrow terminal changed its table; undefined
 * when the table is shown in full.
 */
export function describeTableFit(fit: TableFitChanges): string | undefined {
  const changes: string[] = [];

  if (fit.abbreviatedTokens) {
    changes.push('abbreviated token counts');
  }

  if (fit.hiddenHeaders.length > 0) {
    changes.push(`hid ${joinWithAnd(fit.hiddenHeaders)}`);
  }

  if (fit.shortenedModelNames === true) {
    changes.push('shortened model names');
  }

  const layout = fit.stacked
    ? 'Listed rows instead of a table to fit the terminal'
    : 'Fitted the table to the terminal';

  if (changes.length > 0) {
    return `${layout}: ${changes.join(', ')}. Widen the terminal or use --json for full detail.`;
  }

  return fit.stacked ? `${layout}. Widen the terminal to see the table.` : undefined;
}
