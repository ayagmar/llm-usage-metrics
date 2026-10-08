import type { OptimizeDataResult } from '../cli/usage-data-contracts.js';
import type { OptimizeBaselineRow, OptimizeCandidateRow } from '../optimize/optimize-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import {
  formatApproxUsd,
  formatUsd,
  renderEmptyState,
  renderShareCard,
  renderStat,
  SHARE_MARGIN,
  SHARE_WIDTH,
  svgText,
  truncateLabel,
  type ShareTheme,
} from './share-svg-theme.js';

const statsTop = 160;
const statPitch = 300;
const gridLeft = 330;
const gridRight = SHARE_WIDTH - SHARE_MARGIN;
const gridTop = 314;
const gridBottom = 520;
const CELL_GAP = 6;
// The fixed card fits five candidates and eight months; the rest stay in the report.
const MAX_CANDIDATES = 5;
const MAX_MONTHS = 8;

function formatPercent(value: number | undefined): string {
  if (value === undefined) return '-';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function formatSignedUsd(value: number | undefined): string {
  if (value === undefined) return '-';
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatUsd(Math.abs(value))}`;
}

function savingsColor(value: number | undefined, theme: ShareTheme): string {
  if (value === undefined || value === 0) return theme.textSecondary;
  return value > 0 ? theme.positive : theme.negative;
}

function renderCell(
  theme: ShareTheme,
  x: number,
  y: number,
  width: number,
  height: number,
  ratio: number | undefined,
): string {
  const color = ratio === undefined || ratio === 0 ? theme.line : savingsColor(ratio, theme);
  const opacity = ratio === undefined ? 0.6 : 0.25 + Math.min(1, Math.abs(ratio)) * 0.6;

  return [
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="6" fill="${color}" fill-opacity="${opacity.toFixed(2)}"/>`,
    svgText(x + width / 2, y + height / 2 + 5, formatPercent(ratio), {
      size: 14,
      fill: theme.text,
      mono: true,
      anchor: 'middle',
    }),
  ].join('\n');
}

function renderGrid(
  theme: ShareTheme,
  candidates: OptimizeCandidateRow[],
  periodKeys: string[],
  cells: ReadonlyMap<string, OptimizeCandidateRow>,
): string {
  const cellWidth = (gridRight - gridLeft) / periodKeys.length;
  const cellHeight = Math.min(52, (gridBottom - gridTop) / candidates.length);
  const parts = periodKeys.map((periodKey, column) =>
    svgText(gridLeft + column * cellWidth + cellWidth / 2, gridTop - 12, periodKey, {
      size: 13,
      fill: theme.textMuted,
      anchor: 'middle',
    }),
  );

  candidates.forEach((candidate, row) => {
    const y = gridTop + row * cellHeight;

    parts.push(
      svgText(SHARE_MARGIN, y + cellHeight / 2, truncateLabel(candidate.candidateModel, 26), {
        size: 16,
        fill: theme.text,
      }),
      svgText(SHARE_MARGIN, y + cellHeight / 2 + 18, formatSignedUsd(candidate.savingsUsd), {
        size: 13,
        fill: savingsColor(candidate.savingsUsd, theme),
        mono: true,
      }),
    );

    periodKeys.forEach((periodKey, column) => {
      parts.push(
        renderCell(
          theme,
          gridLeft + column * cellWidth + CELL_GAP / 2,
          y + CELL_GAP / 2,
          cellWidth - CELL_GAP,
          cellHeight - CELL_GAP,
          cells.get(`${candidate.candidateModel}__${periodKey}`)?.savingsRatio,
        ),
      );
    });
  });

  return parts.join('\n');
}

function renderBestSavings(theme: ShareTheme, best: OptimizeCandidateRow): string {
  const saves = (best.savingsUsd ?? 0) >= 0;
  const percent =
    best.savingsRatio === undefined
      ? undefined
      : `${Math.abs(best.savingsRatio * 100).toFixed(1)}% ${saves ? 'cheaper' : 'more expensive'}`;

  return renderStat({
    theme,
    x: SHARE_MARGIN + statPitch * 2,
    y: statsTop,
    label: saves ? 'It would save' : 'It would cost more by',
    value: best.savingsUsd === undefined ? '-' : formatUsd(Math.abs(best.savingsUsd)),
    detail: percent,
    size: 30,
    accent: saves,
  });
}

export function renderOptimizeMonthlyShareSvg(
  optimizeData: OptimizeDataResult,
  theme: ShareTheme,
): string {
  const candidateRows = optimizeData.rows.filter(
    (row): row is OptimizeCandidateRow => row.rowType === 'candidate',
  );
  const baseline = optimizeData.rows.find(
    (row): row is OptimizeBaselineRow => row.rowType === 'baseline' && row.periodKey === 'ALL',
  );
  const periodKeys = [
    ...new Set(candidateRows.map((row) => row.periodKey).filter((key) => key !== 'ALL')),
  ]
    .sort(compareByCodePoint)
    .slice(-MAX_MONTHS);
  const cells = new Map(candidateRows.map((row) => [`${row.candidateModel}__${row.periodKey}`, row]));
  // Best savings first; unpriced candidates last, then by name.
  const candidates = candidateRows
    .filter((row) => row.periodKey === 'ALL')
    .sort(
      (a, b) =>
        (b.savingsUsd ?? Number.NEGATIVE_INFINITY) - (a.savingsUsd ?? Number.NEGATIVE_INFINITY) ||
        compareByCodePoint(a.candidateModel, b.candidateModel),
    )
    .slice(0, MAX_CANDIDATES);
  const best = candidates[0];
  const { provider, candidatesWithMissingPricing: missing, warning } = optimizeData.diagnostics;
  const notes = [
    missing.length > 0 ? `Missing pricing: ${missing.join(', ')}` : undefined,
    warning,
  ].filter((note): note is string => note !== undefined && note.length > 0);
  const body =
    candidates.length === 0 || periodKeys.length === 0
      ? renderEmptyState(theme, 'No months to compare')
      : [
          renderStat({
            theme,
            x: SHARE_MARGIN,
            y: statsTop,
            label: 'Actual cost',
            value: formatApproxUsd(baseline?.baselineCostUsd, baseline?.baselineCostIncomplete),
            size: 30,
          }),
          renderStat({
            theme,
            x: SHARE_MARGIN + statPitch,
            y: statsTop,
            label: 'Best candidate',
            value: truncateLabel(best.candidateModel, 18),
            size: 26,
          }),
          renderBestSavings(theme, best),
          renderGrid(theme, candidates, periodKeys, cells),
          notes.length === 0
            ? ''
            : svgText(SHARE_MARGIN, gridBottom + 24, truncateLabel(notes.join('; '), 130), {
                size: 13,
                fill: theme.warning,
              }),
        ].join('\n');

  return renderShareCard({
    theme,
    title: 'Optimize',
    subtitle: `${provider} usage priced on other models; positive means cheaper`,
    command: 'llm-usage optimize monthly --share',
    footnote:
      periodKeys.length === 0 ? undefined : `${periodKeys[0]} to ${periodKeys[periodKeys.length - 1]}`,
    body,
  });
}
