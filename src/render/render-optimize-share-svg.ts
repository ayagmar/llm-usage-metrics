import type { OptimizeDataResult } from '../cli/usage-data-contracts.js';
import type { OptimizeCandidateRow } from '../optimize/optimize-row.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { escapeSvg, formatUsd, shareTheme } from './share-svg-theme.js';

const W = 1500;
const H = 780;
const pad = { top: 180, right: 70, bottom: 60, left: 260 };

function formatPercent(value: number | undefined): string {
  if (value === undefined) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function cellFill(value: number | undefined): string {
  if (value === undefined) return 'rgba(139,148,158,0.12)';

  const mag = Math.min(1, Math.abs(value));
  const alpha = 0.22 + mag * 0.58;

  if (value > 0) return `rgba(34,197,94,${alpha.toFixed(3)})`;
  if (value < 0) return `rgba(239,68,68,${alpha.toFixed(3)})`;
  return 'rgba(139,148,158,0.15)';
}

function cellTextFill(value: number | undefined): string {
  if (value === undefined) return shareTheme.textMuted;
  if (Math.abs(value) >= 0.35) return '#ffffff';
  return shareTheme.textPrimary;
}

function toCandidateRows(data: OptimizeDataResult): OptimizeCandidateRow[] {
  return data.rows.filter((r): r is OptimizeCandidateRow => r.rowType === 'candidate');
}

function sortPeriodKeys(keys: Iterable<string>): string[] {
  return [...keys].sort(compareByCodePoint);
}

export function renderOptimizeMonthlyShareSvg(optimizeData: OptimizeDataResult): string {
  const candidateRows = toCandidateRows(optimizeData);
  const periodKeys = sortPeriodKeys(
    new Set(candidateRows.map((r) => r.periodKey).filter((k) => k !== 'ALL')),
  );
  const candidateModels = [...new Set(candidateRows.map((r) => r.candidateModel))].sort(
    compareByCodePoint,
  );

  const cellMap = new Map<string, OptimizeCandidateRow>();
  for (const row of candidateRows) {
    cellMap.set(`${row.candidateModel}__${row.periodKey}`, row);
  }

  const allByCandidate = new Map<string, OptimizeCandidateRow>();
  for (const row of candidateRows) {
    if (row.periodKey === 'ALL') allByCandidate.set(row.candidateModel, row);
  }

  const chartLeft = pad.left;
  const chartTop = pad.top;
  const chartRight = W - pad.right;
  const chartBottom = H - pad.bottom;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  const rowCount = Math.max(1, candidateModels.length);
  const colCount = Math.max(1, periodKeys.length);
  const cellW = chartW / colCount;
  const cellH = chartH / rowCount;

  const gridCells: string[] = [];
  const colLabels: string[] = [];
  const rowLabels: string[] = [];

  for (let c = 0; c < periodKeys.length; c++) {
    const x = chartLeft + c * cellW + cellW / 2;
    colLabels.push(
      `<text x="${x.toFixed(2)}" y="${(chartTop - 14).toFixed(0)}" text-anchor="middle" font-size="14" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(periodKeys[c])}</text>`,
    );
  }

  for (let r = 0; r < candidateModels.length; r++) {
    const model = candidateModels[r];
    const y = chartTop + r * cellH + cellH / 2 + 5;
    const allRow = allByCandidate.get(model);

    const allLabel =
      allRow?.savingsUsd === undefined ? '-' : formatUsd(Math.abs(allRow.savingsUsd));
    const allColor =
      allRow?.savingsUsd === undefined
        ? shareTheme.textMuted
        : allRow.savingsUsd > 0
          ? '#22c55e'
          : allRow.savingsUsd < 0
            ? '#ef4444'
            : shareTheme.textSecondary;
    const prefix =
      allRow?.savingsUsd === undefined
        ? ''
        : allRow.savingsUsd > 0
          ? '+'
          : allRow.savingsUsd < 0
            ? '-'
            : '';

    rowLabels.push(
      `<text x="${(chartLeft - 16).toFixed(0)}" y="${y.toFixed(0)}" text-anchor="end" font-size="14" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">${escapeSvg(model)}</text>`,
    );
    rowLabels.push(
      `<text x="${(chartLeft - 16).toFixed(0)}" y="${(y + 16).toFixed(0)}" text-anchor="end" font-size="12" fill="${allColor}" font-family="${shareTheme.font}">ALL: ${escapeSvg(prefix + allLabel)}</text>`,
    );

    for (let c = 0; c < periodKeys.length; c++) {
      const row = cellMap.get(`${model}__${periodKeys[c]}`);
      const x = chartLeft + c * cellW;
      const yTop = chartTop + r * cellH;
      const pct = row?.savingsPct;

      gridCells.push(
        `<rect x="${(x + 2).toFixed(2)}" y="${(yTop + 2).toFixed(2)}" width="${Math.max(0, cellW - 4).toFixed(2)}" height="${Math.max(0, cellH - 4).toFixed(2)}" fill="${cellFill(pct)}" rx="6"/>`,
      );
      gridCells.push(
        `<text x="${(x + cellW / 2).toFixed(2)}" y="${(yTop + cellH / 2 + 5).toFixed(2)}" text-anchor="middle" font-size="13" font-weight="600" fill="${cellTextFill(pct)}" font-family="${shareTheme.font}">${escapeSvg(formatPercent(pct))}</text>`,
      );
    }
  }

  const provider = optimizeData.diagnostics.provider;
  const missing = optimizeData.diagnostics.candidatesWithMissingPricing;
  const warning = optimizeData.diagnostics.warning ?? '';
  const commandText = 'llm-usage optimize monthly --share';
  const badgeW = commandText.length * 9.5 + 28;
  const badgeX = W - pad.right - badgeW;

  const noData =
    candidateModels.length === 0 || periodKeys.length === 0
      ? `<text x="${(W / 2).toFixed(0)}" y="${(H / 2).toFixed(0)}" text-anchor="middle" font-size="20" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">No monthly optimize data available</text>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${shareTheme.bg}"/>
<text x="${pad.left}" y="52" font-size="32" font-weight="700" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Monthly Optimize</text>
<text x="${pad.left}" y="78" font-size="15" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">Savings % heatmap by candidate and month</text>
<rect x="${badgeX.toFixed(0)}" y="30" width="${badgeW.toFixed(0)}" height="34" rx="8" fill="${shareTheme.cardBg}" stroke="${shareTheme.cardBorder}"/>
<text x="${(badgeX + badgeW / 2).toFixed(0)}" y="52" text-anchor="middle" font-size="14" fill="${shareTheme.textSecondary}" font-family="${shareTheme.mono}">${escapeSvg(commandText)}</text>
<text x="${pad.left}" y="112" font-size="15" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Provider: <tspan font-weight="700">${escapeSvg(provider)}</tspan></text>
<text x="${pad.left + 280}" y="112" font-size="14" fill="#22c55e" font-family="${shareTheme.font}">● positive = savings</text>
<text x="${pad.left + 480}" y="112" font-size="14" fill="#ef4444" font-family="${shareTheme.font}">● negative = higher cost</text>
${missing.length > 0 ? `<text x="${pad.left}" y="136" font-size="13" fill="#eab308" font-family="${shareTheme.font}">Missing pricing: ${escapeSvg(missing.join(', '))}</text>` : ''}
${warning ? `<text x="${pad.left}" y="158" font-size="13" fill="#eab308" font-family="${shareTheme.font}">${escapeSvg(warning)}</text>` : ''}
<rect x="${chartLeft}" y="${chartTop}" width="${chartW}" height="${chartH}" fill="${shareTheme.cardBg}" rx="10"/>
${gridCells.join('\n')}
${colLabels.join('\n')}
${rowLabels.join('\n')}
${noData}
</svg>`;
}
