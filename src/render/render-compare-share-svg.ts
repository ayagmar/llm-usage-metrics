import type {
  CompareDataResult,
  CompareMetricKey,
  CompareMetricRow,
} from '../cli/usage-data-contracts.js';
import {
  escapeSvg,
  formatApproxUsd,
  formatInteger,
  renderShareCommandBadge,
  renderShareDocument,
  renderStatTile,
  shareTheme,
  type StatTileGeometry,
} from './share-svg-theme.js';

const H = 620;
const left = 80;
const headlineTop = 210;
const tileTop = 300;
const tileHeight = 126;
const tileGap = 28;
// Four tiles between the margins: (1500 - 160 - 3 * 28) / 4 = 314.
const tileWidth = 314;
const RISING_COLOR = '#ef4444';
const FALLING_COLOR = '#22c55e';

function getMetricRow(
  data: CompareDataResult,
  key: CompareMetricKey,
): CompareMetricRow | undefined {
  return data.totals.find((row) => row.key === key);
}

function formatMetricValue(row: CompareMetricRow | undefined, value: number | undefined): string {
  if (row === undefined || value === undefined) {
    return '-';
  }

  return row.valueType === 'usd' ? formatApproxUsd(value, false) : formatInteger(value);
}

function formatSignedRatio(deltaRatio: number | undefined): string | undefined {
  if (deltaRatio === undefined) {
    return undefined;
  }

  const percent = Math.round(Math.abs(deltaRatio) * 100);
  return `${deltaRatio < 0 ? '-' : '+'}${percent}%`;
}

// Cost falling is good: down-arrows render green, up-arrows red.
function toCostHeadlineDelta(row: CompareMetricRow | undefined): { text: string; color: string } {
  if (row?.delta === undefined || row.delta === 0) {
    return { text: 'no change vs baseline', color: shareTheme.textSecondary };
  }

  const arrow = row.delta < 0 ? '▼' : '▲';
  const color = row.delta < 0 ? FALLING_COLOR : RISING_COLOR;
  const percent =
    row.deltaRatio === undefined ? '' : ` ${Math.round(Math.abs(row.deltaRatio) * 100)}%`;

  return { text: `${arrow}${percent} vs baseline`, color };
}

const tileGeometry: StatTileGeometry = {
  left,
  top: tileTop,
  width: tileWidth,
  height: tileHeight,
  gap: tileGap,
};

function renderMetricTile(index: number, label: string, row: CompareMetricRow | undefined): string {
  const value = formatMetricValue(row, row?.current);
  const baseline = formatMetricValue(row, row?.baseline);
  const ratio = formatSignedRatio(row?.deltaRatio);
  const sublabel = `was ${baseline}${ratio === undefined ? '' : ` (${ratio})`}`;

  return renderStatTile(tileGeometry, index, label, value, sublabel);
}

export function renderCompareShareSvg(data: CompareDataResult): string {
  const hasData = data.current.totals.events > 0 || data.baseline.totals.events > 0;
  const subtitle = hasData
    ? `${data.current.window.label} vs ${data.baseline.window.label}`
    : 'No usage data in either window';
  const costRow = getMetricRow(data, 'costUsd');
  const headlineValue = formatApproxUsd(costRow?.current, costRow?.currentCostIncomplete === true);
  const headlineDelta = toCostHeadlineDelta(costRow);

  const body = `<text x="${left}" y="78" font-size="44" font-weight="900" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}">Compare</text>
<text x="${left}" y="112" font-size="18" fill="${shareTheme.textSecondary}" font-family="${shareTheme.font}">${escapeSvg(subtitle)}</text>
${renderShareCommandBadge('llm-usage compare --share')}
<text x="${left}" y="${headlineTop}" font-size="56" font-weight="900" fill="${shareTheme.textPrimary}" font-family="${shareTheme.font}" data-headline-cost="true">${escapeSvg(headlineValue)}</text>
<text x="${left}" y="${headlineTop + 42}" font-size="22" font-weight="700" fill="${headlineDelta.color}" font-family="${shareTheme.font}" data-headline-delta="true">${escapeSvg(headlineDelta.text)}</text>
${renderMetricTile(0, 'Tokens', getMetricRow(data, 'totalTokens'))}
${renderMetricTile(1, 'Cost', costRow)}
${renderMetricTile(2, 'Events', getMetricRow(data, 'events'))}
${renderMetricTile(3, 'Active Days', getMetricRow(data, 'activeDays'))}`;

  return renderShareDocument({
    height: H,
    body,
    footerRightText: `${data.current.window.since} to ${data.current.window.until}`,
  });
}
