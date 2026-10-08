import type { WrappedRecap, WrappedTopItem } from '../wrapped/wrapped-recap.js';
import {
  activityGridWidth,
  countActivityWeeks,
  escapeSvg,
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
  truncateLabel,
  type ShareTheme,
} from './share-svg-theme.js';

const right = SHARE_WIDTH - SHARE_MARGIN;
const statsTop = 150;
// The cost column is wider: it holds the longest figure.
const statColumns = [SHARE_MARGIN, 344, 548, 752, 956];
const gridTop = 272;
const gridLeft = SHARE_MARGIN + 36;
const gridPitch = 19;
const listTop = 458;
const listRowPitch = 24;
const listWidth = 500;
// The card fits three rows per list; the recap carries up to five.
const TOP_LIST_ROWS = 3;

function formatHours(activeMs: number): string {
  const hours = Math.round(activeMs / 3_600_000);

  if (hours === 0) {
    return activeMs > 0 ? '<1' : '0';
  }

  return formatInteger(hours);
}

function renderStats(data: WrappedRecap, theme: ShareTheme): string {
  const stats = [
    {
      label: 'Cost',
      value: formatApproxUsd(data.costUsd, data.costIncomplete),
      detail:
        data.estimatedCacheSavingsUsd === undefined
          ? 'estimated spend'
          : `cache saved ${formatApproxUsd(data.estimatedCacheSavingsUsd, true)}`,
      accent: true,
    },
    {
      label: 'Tokens',
      value: formatCompact(data.totalTokens),
      detail: `${formatInteger(data.eventCount)} events`,
    },
    {
      label: 'Hours',
      value: formatHours(data.activeMs),
      detail: `${formatInteger(data.sessionCount)} sessions`,
    },
    {
      label: 'Active days',
      value: formatInteger(data.activeDays),
      detail: 'this year',
    },
    {
      label: 'Longest streak',
      value: formatInteger(data.longestStreak),
      unit: formatDayUnit(data.longestStreak),
    },
  ];

  return stats
    .map((stat, index) =>
      renderStat({ theme, x: statColumns[index], y: statsTop, size: 32, ...stat }),
    )
    .join('\n');
}

function renderTopList(
  theme: ShareTheme,
  title: string,
  items: readonly WrappedTopItem[],
  x: number,
): string {
  const rows = items.slice(0, TOP_LIST_ROWS).map((item, index) => {
    const y = listTop + 30 + index * listRowPitch;
    const cost = formatApproxUsd(item.costUsd, item.costIncomplete);

    return `<g data-top-item="${escapeSvg(title)}-${index + 1}">
${svgText(x, y, truncateLabel(item.name, 34), { size: 17, fill: theme.text })}
${svgText(x + listWidth, y, `${formatCompact(item.totalTokens)}  ${cost}`, {
  size: 15,
  fill: theme.textSecondary,
  mono: true,
  anchor: 'end',
})}
</g>`;
  });

  return [
    svgText(x, listTop, title, { size: 16, fill: theme.textSecondary }),
    ...(rows.length === 0
      ? [svgText(x, listTop + 30, 'No data', { size: 17, fill: theme.textMuted })]
      : rows),
  ].join('\n');
}

function renderActivity(data: WrappedRecap, theme: ShareTheme): string {
  const gridRight =
    gridLeft + activityGridWidth(countActivityWeeks(data.dailyIntensity), gridPitch);

  return [
    renderActivityGrid({
      theme,
      days: data.dailyIntensity,
      x: gridLeft,
      y: gridTop,
      pitch: gridPitch,
    }),
    renderHeatLegend(theme, gridRight, gridTop + 7 * gridPitch + 20),
  ].join('\n');
}

export function renderWrappedShareSvg(data: WrappedRecap, theme: ShareTheme): string {
  const body =
    data.eventCount === 0
      ? renderEmptyState(theme, `No usage in ${data.year}`)
      : [
          renderStats(data, theme),
          renderActivity(data, theme),
          renderTopList(theme, 'Top models', data.topModels, SHARE_MARGIN),
          renderTopList(theme, 'Top sources', data.topSources, right - listWidth),
        ].join('\n');

  return renderShareCard({
    theme,
    title: `${data.year} Wrapped`,
    subtitle: `A year of LLM usage, ${data.timezone} time`,
    command: `llm-usage wrapped --year ${data.year} --share`,
    footnote: `${data.from} to ${data.to}`,
    body,
  });
}
