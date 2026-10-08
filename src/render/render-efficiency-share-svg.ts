import type { EfficiencyDataResult } from '../cli/usage-data-contracts.js';
import type {
  EfficiencyGrandTotalRow,
  EfficiencyPeriodRow,
  EfficiencyRow,
} from '../efficiency/efficiency-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  formatCompact,
  formatInteger,
  formatUsd,
  renderEmptyState,
  renderShareCard,
  renderStat,
  scaleY,
  SHARE_MARGIN,
  SHARE_WIDTH,
  svgText,
  type ShareTheme,
} from './share-svg-theme.js';

const statsTop = 160;
const statPitch = 268;
const chartLeft = SHARE_MARGIN;
const chartRight = SHARE_WIDTH - SHARE_MARGIN;
// Two panels with their own scales share the month columns:
// spend per commit as a line on top, commit volume as bars below.
const usdPanel = { top: 300, bottom: 390 };
const commitPanel = { top: 430, bottom: 500 };
const monthLabelY = 526;
// Twelve month columns keep every value label readable at the fixed card width.
const MAX_MONTHS = 12;

function isPeriodRow(row: EfficiencyRow): row is EfficiencyPeriodRow {
  return row.rowType === 'period';
}

function isGrandTotalRow(row: EfficiencyRow): row is EfficiencyGrandTotalRow {
  return row.rowType === 'grand_total';
}

function toMonthlyRows(rows: EfficiencyRow[]): EfficiencyPeriodRow[] {
  return rows.filter(isPeriodRow).sort((a, b) => compareByCodePoint(a.periodKey, b.periodKey));
}

function renderSummaryStats(
  allRow: EfficiencyGrandTotalRow | undefined,
  theme: ShareTheme,
): string {
  const stats = [
    { label: 'Spend per commit', value: formatUsd(allRow?.usdPerCommit), accent: true },
    { label: 'Commits', value: formatInteger(allRow?.commitCount ?? 0) },
    { label: 'Cost', value: formatUsd(allRow?.costUsd) },
    {
      label: 'Tokens per commit',
      value:
        allRow?.tokensPerCommit === undefined
          ? '-'
          : formatCompact(Math.round(allRow.tokensPerCommit)),
    },
  ];

  return stats
    .map((stat, index) =>
      renderStat({ theme, x: SHARE_MARGIN + index * statPitch, y: statsTop, size: 30, ...stat }),
    )
    .join('\n');
}

function renderPanelLabel(
  theme: ShareTheme,
  panel: { top: number; bottom: number },
  label: string,
): string {
  return [
    svgText(chartLeft, panel.top - 14, label, { size: 14, fill: theme.textSecondary }),
    `<line x1="${chartLeft}" y1="${panel.bottom}" x2="${chartRight}" y2="${panel.bottom}" stroke="${theme.line}" stroke-width="1"/>`,
  ].join('\n');
}

function renderCharts(monthlyRows: EfficiencyPeriodRow[], theme: ShareTheme): string {
  const slot = (chartRight - chartLeft) / monthlyRows.length;
  const toX = (index: number): number => chartLeft + index * slot + slot / 2;
  const maxCommits = Math.max(1, ...monthlyRows.map((row) => row.commitCount)) * 1.15;
  const maxUsd = Math.max(0.01, ...monthlyRows.map((row) => Math.max(0, row.usdPerCommit ?? 0)));
  const usdScale = maxUsd * 1.15;
  const usdPoints = monthlyRows.flatMap((row, index) =>
    row.usdPerCommit === undefined
      ? []
      : [
          {
            x: toX(index),
            y: scaleY(row.usdPerCommit, usdScale, usdPanel.top, usdPanel.bottom),
            value: row.usdPerCommit,
          },
        ],
  );
  const usdLine =
    usdPoints.length >= 2
      ? `<polyline points="${usdPoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')}" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`
      : '';
  const usdMarks = usdPoints.map((point) =>
    [
      `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="5" fill="${theme.accent}"/>`,
      svgText(point.x, point.y - 12, formatUsd(point.value), {
        size: 13,
        fill: theme.text,
        mono: true,
        anchor: 'middle',
      }),
    ].join('\n'),
  );
  const barWidth = Math.min(44, slot * 0.5);
  const commitMarks = monthlyRows.map((row, index) => {
    const yTop = scaleY(row.commitCount, maxCommits, commitPanel.top, commitPanel.bottom);

    return [
      `<rect x="${(toX(index) - barWidth / 2).toFixed(2)}" y="${yTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${(commitPanel.bottom - yTop).toFixed(2)}" rx="3" fill="${theme.heat[2]}"/>`,
      svgText(toX(index), yTop - 8, formatInteger(row.commitCount), {
        size: 13,
        fill: theme.textSecondary,
        mono: true,
        anchor: 'middle',
      }),
    ].join('\n');
  });
  const monthLabels = monthlyRows.map((row, index) =>
    svgText(toX(index), monthLabelY, row.periodKey, {
      size: 13,
      fill: theme.textMuted,
      anchor: 'middle',
    }),
  );

  return [
    renderPanelLabel(theme, usdPanel, 'Spend per commit'),
    usdLine,
    ...usdMarks,
    renderPanelLabel(theme, commitPanel, 'Commits'),
    ...commitMarks,
    ...monthLabels,
  ].join('\n');
}

export function renderEfficiencyMonthlyShareSvg(
  efficiencyData: EfficiencyDataResult,
  theme: ShareTheme,
): string {
  const allMonths = toMonthlyRows(efficiencyData.rows);
  const monthlyRows = allMonths.slice(-MAX_MONTHS);
  const allRow = efficiencyData.rows.find(isGrandTotalRow);
  const subtitle =
    allMonths.length > MAX_MONTHS
      ? `Spend per commit, month by month (last ${MAX_MONTHS} of ${allMonths.length} months)`
      : 'Spend per commit, month by month';
  const body =
    monthlyRows.length === 0
      ? renderEmptyState(theme, 'No months with commits and usage')
      : `${renderSummaryStats(allRow, theme)}\n${renderCharts(monthlyRows, theme)}`;

  return renderShareCard({
    theme,
    title: 'Efficiency',
    subtitle,
    command: 'llm-usage efficiency monthly --share',
    footnote:
      monthlyRows.length === 0
        ? undefined
        : `${monthlyRows[0].periodKey} to ${monthlyRows[monthlyRows.length - 1].periodKey}`,
    body,
  });
}
