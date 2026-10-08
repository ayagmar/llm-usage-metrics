import type {
  CompareDataResult,
  CompareMetricKey,
  CompareMetricRow,
} from '../cli/usage-data-contracts.js';
import {
  formatApproxUsd,
  formatCompact,
  formatInteger,
  renderEmptyState,
  renderShareCard,
  renderStat,
  SHARE_MARGIN,
  SHARE_WIDTH,
  svgText,
  type ShareTheme,
} from './share-svg-theme.js';

const right = SHARE_WIDTH - SHARE_MARGIN;
const heroTop = 176;
const barsLeft = 560;
const barsMaxWidth = 380;
const rowsTop = 176;
const rowPitch = 92;
const METRICS: readonly { key: CompareMetricKey; label: string }[] = [
  { key: 'costUsd', label: 'Cost' },
  { key: 'totalTokens', label: 'Tokens' },
  { key: 'events', label: 'Events' },
  { key: 'activeDays', label: 'Active days' },
];

function getMetricRow(
  data: CompareDataResult,
  key: CompareMetricKey,
): CompareMetricRow | undefined {
  return data.totals.find((row) => row.key === key);
}

function formatMetricValue(row: CompareMetricRow, value: number | undefined): string {
  if (value === undefined) {
    return '-';
  }

  if (row.valueType === 'usd') {
    return formatApproxUsd(value, false);
  }

  return row.key === 'totalTokens' ? formatCompact(value) : formatInteger(value);
}

function formatSignedRatio(deltaRatio: number | undefined): string {
  if (deltaRatio === undefined) {
    return '';
  }

  const percent = Math.round(Math.abs(deltaRatio) * 100);
  return `${deltaRatio < 0 ? '-' : '+'}${percent}%`;
}

// Cost falling is good, so a drop reads positive and a rise negative.
function toCostDelta(
  row: CompareMetricRow | undefined,
  theme: ShareTheme,
): { text: string; color: string } {
  if (row?.delta === undefined || row.delta === 0) {
    return { text: 'No change from the baseline', color: theme.textSecondary };
  }

  const direction = row.delta < 0 ? 'Down' : 'Up';
  const amount = formatApproxUsd(Math.abs(row.delta), row.deltaCostIncomplete);
  const percent =
    row.deltaRatio === undefined ? '' : ` (${Math.round(Math.abs(row.deltaRatio) * 100)}%)`;

  return {
    text: `${direction} ${amount}${percent} from the baseline`,
    color: row.delta < 0 ? theme.positive : theme.negative,
  };
}

function renderMetricRow(
  theme: ShareTheme,
  index: number,
  label: string,
  row: CompareMetricRow | undefined,
): string {
  const top = rowsTop + index * rowPitch;
  const current = row?.current ?? 0;
  const baseline = row?.baseline ?? 0;
  const max = Math.max(current, baseline);
  const barWidth = (value: number) =>
    max <= 0 ? 0 : Math.max(value > 0 ? 3 : 0, (value / max) * barsMaxWidth);
  const valueX = barsLeft + barsMaxWidth + 16;

  return `<g data-compare-metric="${row?.key ?? label}">
${svgText(barsLeft, top, label, { size: 16, fill: theme.textSecondary })}
${svgText(right, top, row === undefined ? '' : formatSignedRatio(row.deltaRatio), { size: 15, fill: theme.textSecondary, mono: true, anchor: 'end' })}
<rect x="${barsLeft}" y="${top + 14}" width="${barWidth(current).toFixed(2)}" height="16" rx="3" fill="${theme.accent}"/>
${svgText(valueX, top + 27, row === undefined ? '-' : formatMetricValue(row, row.current), { size: 15, fill: theme.text, mono: true })}
<rect x="${barsLeft}" y="${top + 38}" width="${barWidth(baseline).toFixed(2)}" height="16" rx="3" fill="${theme.heat[2]}"/>
${svgText(valueX, top + 51, row === undefined ? '-' : formatMetricValue(row, row.baseline), { size: 15, fill: theme.textMuted, mono: true })}
</g>`;
}

function renderBody(data: CompareDataResult, theme: ShareTheme): string {
  const costRow = getMetricRow(data, 'costUsd');
  const delta = toCostDelta(costRow, theme);
  const legendY = rowsTop + METRICS.length * rowPitch - 6;

  return [
    renderStat({
      theme,
      x: SHARE_MARGIN,
      y: heroTop,
      label: data.current.window.label,
      value: formatApproxUsd(costRow?.current, costRow?.currentCostIncomplete === true),
      size: 64,
      accent: true,
      detail: `${data.baseline.window.label}: ${formatApproxUsd(costRow?.baseline, costRow?.baselineCostIncomplete === true)}`,
    }),
    svgText(SHARE_MARGIN, heroTop + 180, delta.text, {
      size: 22,
      weight: 600,
      fill: delta.color,
      attributes: 'data-headline-delta="true"',
    }),
    ...METRICS.map((metric, index) =>
      renderMetricRow(theme, index, metric.label, getMetricRow(data, metric.key)),
    ),
    `<rect x="${barsLeft}" y="${legendY - 10}" width="12" height="12" rx="3" fill="${theme.accent}"/>`,
    svgText(barsLeft + 20, legendY, data.current.window.label, {
      size: 14,
      fill: theme.textSecondary,
    }),
    `<rect x="${barsLeft + 230}" y="${legendY - 10}" width="12" height="12" rx="3" fill="${theme.heat[2]}"/>`,
    svgText(barsLeft + 250, legendY, data.baseline.window.label, {
      size: 14,
      fill: theme.textSecondary,
    }),
  ].join('\n');
}

export function renderCompareShareSvg(data: CompareDataResult, theme: ShareTheme): string {
  const hasData = data.current.totals.events > 0 || data.baseline.totals.events > 0;

  return renderShareCard({
    theme,
    title: 'Compare',
    subtitle: `${data.current.window.label} against ${data.baseline.window.label}`,
    command: 'llm-usage compare --share',
    footnote: `${data.current.window.since} to ${data.current.window.until}`,
    body: hasData ? renderBody(data, theme) : renderEmptyState(theme, 'No usage in either window'),
  });
}
