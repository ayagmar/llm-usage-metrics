import type { ActivityDay } from '../aggregate/daily-activity.js';
import { getIsoDayOfWeekFromDateKey } from '../utils/time-buckets.js';
import type { TextStyler } from './terminal-style-policy.js';
import { MONTH_LABELS } from './month-labels.js';

export type HeatmapStyles = {
  dim: TextStyler;
  level: (level: ActivityDay['level']) => TextStyler;
};

// One glyph per intensity level; shading still reads without color.
const LEVEL_GLYPHS = ['·', '░', '▒', '▓', '█'] as const;
const LEVELS = [0, 1, 2, 3, 4] as const satisfies readonly ActivityDay['level'][];
const ROW_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const ROW_LABEL_WIDTH = 4;
const MONTH_LABEL_WIDTH = 3;
/** Fewer weeks than this is not worth drawing. */
const MIN_HEATMAP_WEEKS = 13;
// `Less ·░▒▓█ More`: the legend must fit the grid's width too.
const LEGEND_WIDTH = 'Less '.length + LEVEL_GLYPHS.length + ' More'.length;

function renderCell(level: ActivityDay['level'], styles: HeatmapStyles): string {
  return styles.level(level)(LEVEL_GLYPHS[level]);
}

/** Splits days into Monday-first weeks; the first day must be a Monday. */
function toWeeks(days: readonly ActivityDay[]): ActivityDay[][] {
  const weeks: ActivityDay[][] = [];

  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }

  return weeks;
}

function renderMonthLabels(weeks: readonly ActivityDay[][]): string {
  let line = '';
  let previousMonth = '';

  weeks.forEach((week, column) => {
    const month = week[0].date.slice(5, 7);

    // Skip a label that would overlap the previous one or run past the grid.
    if (
      month !== previousMonth &&
      (line.length === 0 || line.length < column) &&
      column + MONTH_LABEL_WIDTH <= weeks.length
    ) {
      line = line.padEnd(column) + MONTH_LABELS[Number(month) - 1];
    }

    previousMonth = month;
  });

  return line;
}

/**
 * GitHub-style grid: one column per ISO week, one row per weekday (Mon..Sun).
 * Keeps the most recent weeks that fit `maxWidth`; returns no lines when too
 * narrow, and an empty cell for days after the last one.
 */
export function renderActivityHeatmap(
  days: readonly ActivityDay[],
  styles: HeatmapStyles,
  maxWidth?: number,
): string[] {
  if (days.length === 0 || getIsoDayOfWeekFromDateKey(days[0].date) !== 1) {
    return [];
  }

  const allWeeks = toWeeks(days);
  const weekCount =
    maxWidth === undefined
      ? allWeeks.length
      : Math.min(allWeeks.length, maxWidth - ROW_LABEL_WIDTH);

  if (weekCount < Math.max(MIN_HEATMAP_WEEKS, LEGEND_WIDTH)) {
    return [];
  }

  const weeks = allWeeks.slice(-weekCount);
  const lines = [' '.repeat(ROW_LABEL_WIDTH) + styles.dim(renderMonthLabels(weeks))];

  for (let row = 0; row < 7; row += 1) {
    const cells = weeks
      .map((week) =>
        // The last week stops at the final day; later weekdays stay blank.
        row < week.length ? renderCell(week[row].level, styles) : ' ',
      )
      .join('');

    lines.push(styles.dim(ROW_LABELS[row].padEnd(ROW_LABEL_WIDTH)) + cells.trimEnd());
  }

  const legend = `Less ${LEVELS.map((level) => renderCell(level, styles)).join('')} More`;
  lines.push(' '.repeat(ROW_LABEL_WIDTH) + styles.dim(legend));

  return lines;
}
