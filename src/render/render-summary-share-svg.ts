import type {
  SummaryDataResult,
  SummaryMachineTotals,
  SummaryPeriod,
} from '../cli/usage-data-contracts.js';
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
  truncateLabel,
  type ShareTheme,
} from './share-svg-theme.js';
import { MONTH_LABELS } from './month-labels.js';

const right = SHARE_WIDTH - SHARE_MARGIN;
const statsTop = 168;
const gridTop = 352;
const gridLeft = SHARE_MARGIN + 36;
const gridPitch = 19;

function formatShortDate(date: string): string {
  return `${MONTH_LABELS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
}

function findPeriod(data: SummaryDataResult, key: SummaryPeriod['key']): SummaryPeriod | undefined {
  return data.periods.find((period) => period.key === key);
}

function renderStats(data: SummaryDataResult, theme: ShareTheme): string {
  const { activity } = data;
  const monthToDate = findPeriod(data, 'monthToDate');
  const bestDay = activity.bestDay;
  // The last column leaves room for a month-to-date figure like ~$123,456.78.
  const columns = [right - 660, right - 450, right - 250];

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

const machinesLeft = right - 660;
const machinesTop = 270;
const machineSlotWidth = 190;
/** Legend slots under the bar; more machines than this share the last slot. */
const machineSlots = 3;

type MachineShare = { label: string; share: number; fill: string };

/** Month-to-date shares by cost, or by tokens when the month has no known cost. */
function toMachineShares(
  machines: readonly SummaryMachineTotals[],
  byCost: boolean,
  theme: ShareTheme,
): MachineShare[] {
  const totalCost = machines.reduce((sum, machine) => sum + (machine.costUsd ?? 0), 0);
  const totalTokens = machines.reduce((sum, machine) => sum + machine.totalTokens, 0);
  const shareOf = (machine: SummaryMachineTotals) =>
    byCost ? (machine.costUsd ?? 0) / totalCost : machine.totalTokens / totalTokens;
  const fills = [theme.heat[3], theme.heat[2], theme.textMuted];
  const named = machines.length <= machineSlots ? machines : machines.slice(0, machineSlots - 1);
  const shares = named.map((machine, index) => ({
    label: machine.machine,
    share: shareOf(machine),
    fill: fills[index],
  }));

  if (named.length < machines.length) {
    const rest = machines.slice(named.length);
    shares.push({
      label: `${formatInteger(rest.length)} others`,
      share: rest.reduce((sum, machine) => sum + shareOf(machine), 0),
      fill: fills[machineSlots - 1],
    });
  }

  return shares;
}

/** A bar split by machine with a legend, for a month counted across machines. */
function renderMachines(data: SummaryDataResult, theme: ShareTheme): string {
  const monthToDate = findPeriod(data, 'monthToDate');
  const machines = monthToDate?.machines ?? [];
  const byCost = machines.some((machine) => (machine.costUsd ?? 0) > 0);

  if (machines.length < 2 || (!byCost && !machines.some((machine) => machine.totalTokens > 0))) {
    return '';
  }

  const shares = toMachineShares(machines, byCost, theme);
  // Like the cost figures, a `~` marks shares computed from incomplete costs.
  const approximate = byCost && monthToDate?.totals.costIncomplete === true ? '~' : '';
  const barWidth = right - machinesLeft;
  const barTop = machinesTop + 12;
  const legendY = barTop + 30;
  let segmentX = machinesLeft;
  const parts = [
    svgText(
      machinesLeft,
      machinesTop,
      byCost ? 'This month by machine' : 'This month by machine (tokens)',
      {
        size: 16,
        fill: theme.textSecondary,
      },
    ),
    `<rect x="${machinesLeft}" y="${barTop}" width="${barWidth}" height="8" rx="2" fill="${theme.line}"/>`,
  ];

  shares.forEach((share, index) => {
    const width = share.share * barWidth;
    const slotX = machinesLeft + index * machineSlotWidth;
    const segmentLeft = segmentX;
    segmentX += width;

    parts.push(
      `<rect x="${segmentLeft.toFixed(2)}" y="${barTop}" width="${width.toFixed(2)}" height="8" rx="2" fill="${share.fill}"/>`,
      `<circle cx="${slotX + 5}" cy="${legendY - 5}" r="5" fill="${share.fill}"/>`,
      svgText(slotX + 18, legendY, truncateLabel(share.label, 12), {
        size: 15,
        fill: theme.text,
      }),
      svgText(slotX + 166, legendY, `${approximate}${String(Math.round(share.share * 100))}%`, {
        size: 15,
        fill: theme.textSecondary,
        mono: true,
        anchor: 'end',
      }),
    );
  });

  return `<g data-machines="true">
${parts.join('\n')}
</g>`;
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
      : [renderStats(data, theme), renderMachines(data, theme), renderActivity(data, theme)]
          .filter(Boolean)
          .join('\n');

  return renderShareCard({
    theme,
    title: 'LLM usage activity',
    subtitle: `Past 12 months, ${data.timezone} time`,
    command: 'llm-usage summary --share',
    footnote: `${data.activity.from} to ${data.activity.to}`,
    body,
  });
}
