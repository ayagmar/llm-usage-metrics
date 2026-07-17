import {
  resolveTtyColumns,
  type TerminalColumnsSource,
  visibleWidth,
} from '../render/table-text-layout.js';

function detectTerminalOverflowColumns(
  reportOutput: string,
  stdoutState: TerminalColumnsSource,
): number | undefined {
  const terminalColumns = resolveTtyColumns(stdoutState);

  if (terminalColumns === undefined) {
    return undefined;
  }

  const allLines = reportOutput.trimEnd().split('\n');
  const tableLikeLinePattern = /[│╭╮╰╯├┼┬┴┌┐└┘]|^\s*\|.*\|\s*$/u;
  const tableLines = allLines.filter((line) => tableLikeLinePattern.test(line));

  if (tableLines.length === 0) {
    return undefined;
  }

  const maxLineWidth = tableLines.reduce(
    (maxWidth, line) => Math.max(maxWidth, visibleWidth(line)),
    0,
  );

  if (maxLineWidth <= terminalColumns) {
    return undefined;
  }

  return maxLineWidth - terminalColumns;
}

export function warnIfTerminalTableOverflows(
  reportOutput: string,
  warn: (message: string) => void,
  stdoutState: TerminalColumnsSource = process.stdout,
): void {
  const overflowColumns = detectTerminalOverflowColumns(reportOutput, stdoutState);

  if (overflowColumns !== undefined) {
    warn(
      `Report table is wider than terminal by ${overflowColumns} column(s). Use fullscreen/maximized terminal for better readability.`,
    );
  }
}
