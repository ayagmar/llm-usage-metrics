import type { SummaryDataResult, SummaryPeriod } from '../cli/usage-data-contracts.js';
import {
  activityGridWidth,
  countActivityWeeks,
  formatApproxUsd,
  formatCompact,
  formatDayUnit,
  formatInteger,
  renderActivityGrid,
  renderEmptyState,
  renderHeatLegend,
  renderShareCard,
  renderStat,
  SHARE_MARGIN,
  SHARE_WIDTH,
  svgText,
  type ShareTheme,
} from './share-svg-theme.js';

const right = SHARE_WIDTH - SHARE_MARGIN;
const statsTop = 168;
const gridTop = 352;
const gridLeft = SHARE_MARGIN + 36;
const gridPitch = 19;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatShortDate(date: string): string {
  return `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

function findPeriod(data: SummaryDataResult, key: SummaryPeriod['key']): SummaryPeriod | undefined {
  return data.periods.find((period) => period.key === key);
}

function renderStats(data: SummaryDataResult, theme: ShareTheme): string {
  const { activity } = data;
  const monthToDate = findPeriod(data, 'monthToDate');
  const bestDay = activity.bestDay;
  const columns = [right - 650, right - 430, right - 210];

  return [
    renderStat({
      theme,
      x: SHARE_MARGIN,
      y: statsTop,
      label: 'Current streak',
      value: formatInteger(activity.currentStreak),
      unit: formatDayUnit(activity.currentStreak),
      size: 96,
      accent: true,
    }),
    renderStat({
      theme,
      x: columns[0],
      y: statsTop,
      label: 'Longest streak',
      value: formatInteger(activity.longestStreak),
      unit: formatDayUnit(activity.longestStreak),
    }),
    renderStat({
      theme,
      x: columns[1],
      y: statsTop,
      label: 'Best day',
      value: bestDay === undefined ? '-' : formatShortDate(bestDay.date),
      detail:
        bestDay === undefined
          ? undefined
          : bestDay.costUsd === undefined
            ? `${formatCompact(bestDay.totalTokens)} tokens`
            : formatApproxUsd(bestDay.costUsd, bestDay.costIncomplete),
    }),
    renderStat({
      theme,
      x: columns[2],
      y: statsTop,
      label: 'This month',
      value: formatApproxUsd(monthToDate?.totals.costUsd, monthToDate?.totals.costIncomplete),
      detail:
        monthToDate === undefined
          ? undefined
          : `${formatCompact(monthToDate.totals.totalTokens)} tokens`,
    }),
  ].join('\n');
}

function renderActivity(data: SummaryDataResult, theme: ShareTheme): string {
  const { activity } = data;
  const gridBottom = gridTop + 7 * gridPitch;
  const gridRight = gridLeft + activityGridWidth(countActivityWeeks(activity.days), gridPitch);

  return [
    renderActivityGrid({ theme, days: activity.days, x: gridLeft, y: gridTop, pitch: gridPitch }),
    svgText(gridLeft, gridBottom + 30, `${formatInteger(activity.activeDays)} active days`, {
      size: 15,
      fill: theme.textSecondary,
    }),
    renderHeatLegend(theme, gridRight, gridBottom + 30),
  ].join('\n');
}

export function renderSummaryShareSvg(data: SummaryDataResult, theme: ShareTheme): string {
  const body =
    data.activity.activeDays === 0
      ? renderEmptyState(theme, 'No usage in the past year')
      : `${renderStats(data, theme)}\n${renderActivity(data, theme)}`;

  return renderShareCard({
    theme,
    title: 'LLM usage activity',
    subtitle: `Past 12 months, ${data.timezone} time`,
    command: 'llm-usage summary --share',
    footnote: `${data.activity.from} to ${data.activity.to}`,
    body,
  });
}
