/** `--top N` for reports that always show a top list; undefined when not passed. */
export function parsePositiveTopOption(top: string | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  const normalized = top.trim();

  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error('--top must be a positive integer');
  }

  return Number.parseInt(normalized, 10);
}

/** `--top N` where 0 shows every row; undefined when not passed. */
export function parseTopRowsOption(top: string | undefined): number | undefined {
  if (top === undefined) {
    return undefined;
  }

  const normalized = top.trim();
  const parsed = Number.parseInt(normalized, 10);

  if (!/^\d+$/u.test(normalized) || Number.isNaN(parsed)) {
    throw new Error('--top must be a non-negative integer (0 shows all rows)');
  }

  return parsed;
}

const DEFAULT_TOP_ROWS = 20;

/** The default `--top` of `projects` and of each month's projects in `value`. */
export const DEFAULT_PROJECT_ROWS = 10;

/**
 * The row limit of a `--top` list: `--top 0` shows every row; without `--top`, the first
 * `defaultLimit` rows (20), or every row when `showAllByDefault` (e.g. rows picked by --id).
 */
export function resolveTopRowLimit(
  top: number | undefined,
  showAllByDefault = false,
  defaultLimit = DEFAULT_TOP_ROWS,
): number | undefined {
  if (top !== undefined) {
    return top === 0 ? undefined : top;
  }

  return showAllByDefault ? undefined : defaultLimit;
}

/** The first `limit` rows, with the note naming what --top left out. */
export function limitRows<Row>(
  rows: Row[],
  limit: number | undefined,
  rowNoun: string,
  rankedBy = 'cost',
): { rows: Row[]; limitNote?: string } {
  if (limit === undefined || rows.length <= limit) {
    return { rows };
  }

  return {
    rows: rows.slice(0, limit),
    limitNote: `Showing top ${limit} of ${rows.length} ${rowNoun} by ${rankedBy}. Use --top 0 for all.`,
  };
}
