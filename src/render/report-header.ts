import pc from 'picocolors';
import { resolveTtyColumns, visibleWidth } from './table-text-layout.js';

export type ReportHeaderOptions = {
  title: string;
  useColor?: boolean;
  /** Defaults to the stdout TTY width; a title too wide for the box prints unboxed. */
  terminalWidth?: number;
};

function getBoxWidth(content: string): number {
  return visibleWidth(content) + 4;
}

function drawBoxLine(width: number, left: string, middle: string, right: string): string {
  return left + middle.repeat(width - 2) + right;
}

function padLine(content: string, width: number): string {
  const padding = width - 2 - visibleWidth(content);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;
  return '│' + ' '.repeat(leftPad) + content + ' '.repeat(rightPad) + '│';
}

export function renderReportHeader(options: ReportHeaderOptions): string {
  const { title, useColor = true } = options;
  const boxWidth = getBoxWidth(title);
  const terminalWidth = options.terminalWidth ?? resolveTtyColumns(process.stdout);

  if (terminalWidth !== undefined && boxWidth > terminalWidth) {
    return useColor ? pc.bold(pc.white(title)) : title;
  }

  const lines: string[] = [];

  const topBorder = drawBoxLine(boxWidth, '┌', '─', '┐');
  lines.push(useColor ? pc.gray(topBorder) : topBorder);

  const titleLine = padLine(title, boxWidth);
  lines.push(useColor ? pc.white(titleLine) : titleLine);

  const bottomBorder = drawBoxLine(boxWidth, '└', '─', '┘');
  lines.push(useColor ? pc.gray(bottomBorder) : bottomBorder);

  return lines.join('\n');
}

/**
 * The line a report prints instead of an empty table. `scope` names the window searched
 * (`in 2026`, `for the selected date range`); filters are named only when passed.
 */
export function formatNoUsageMessage(filtered: boolean, scope?: string): string {
  const scopeText = scope === undefined ? '' : ` ${scope}`;
  const filterText = filtered ? ' for the selected filters' : '';

  return `No usage data found${scopeText}${filterText}.`;
}
