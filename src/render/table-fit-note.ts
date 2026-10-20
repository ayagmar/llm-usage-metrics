/** What fitting a table to the terminal changed, for the stderr note that says so. */
export type TableFitChanges = {
  /** Token counts are abbreviated, such as `24.3K` for `24,312`. */
  abbreviatedTokens: boolean;
  /** Other counts are abbreviated, such as tool calls. */
  abbreviatedCounts?: boolean;
  /** Headers of the columns the fit left out, in the order they were hidden. */
  hiddenHeaders: readonly string[];
  shortenedModelNames?: boolean;
  /** Long names other than models are cut, such as tool names and projects. */
  shortenedNames?: boolean;
  /** Rows are listed as label/value lines because no table step fits the terminal. */
  stacked: boolean;
};

function joinWithAnd(items: readonly string[]): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What fitting changed across a report's tables, so it gets one note. */
function mergeTableFits(fits: readonly TableFitChanges[]): TableFitChanges {
  return {
    abbreviatedTokens: fits.some((fit) => fit.abbreviatedTokens),
    abbreviatedCounts: fits.some((fit) => fit.abbreviatedCounts === true),
    hiddenHeaders: [...new Set(fits.flatMap((fit) => fit.hiddenHeaders))],
    shortenedModelNames: fits.some((fit) => fit.shortenedModelNames === true),
    shortenedNames: fits.some((fit) => fit.shortenedNames === true),
    stacked: fits.some((fit) => fit.stacked),
  };
}

/**
 * The one wording every report uses to say a narrow terminal changed its tables; undefined
 * when every table is shown in full. A report with several tables gets one note.
 */
export function describeTableFit(...fits: readonly TableFitChanges[]): string | undefined {
  const fit = mergeTableFits(fits);
  const changes: string[] = [];

  if (fit.abbreviatedTokens) {
    changes.push('abbreviated token counts');
  }

  if (fit.abbreviatedCounts === true) {
    changes.push('abbreviated counts');
  }

  if (fit.hiddenHeaders.length > 0) {
    changes.push(`hid ${joinWithAnd(fit.hiddenHeaders)}`);
  }

  if (fit.shortenedModelNames === true) {
    changes.push('shortened model names');
  }

  if (fit.shortenedNames === true) {
    changes.push('shortened long names');
  }

  const changedTables = fits.length > 1 ? fits.filter((one) => describeTableFit(one)) : fits;
  const plural = changedTables.length > 1;
  const table = plural ? 'tables' : 'table';
  // Listed rows lead the note only when every changed table became a list.
  const allStacked = fit.stacked && changedTables.every((one) => one.stacked);

  if (fit.stacked && !allStacked) {
    changes.push('listed rows where no table fit');
  }

  const layout = allStacked
    ? `Listed rows instead of ${plural ? 'tables' : 'a table'} to fit the terminal`
    : `Fitted the ${table} to the terminal`;

  if (changes.length > 0) {
    return `${layout}: ${changes.join(', ')}. Widen the terminal or use --json for full detail.`;
  }

  return allStacked ? `${layout}. Widen the terminal to see the ${table}.` : undefined;
}

/** A rendered report and the stderr notes about what a narrow terminal changed in it. */
export type RenderedReportWithNotes = {
  output: string;
  notes: string[];
};
