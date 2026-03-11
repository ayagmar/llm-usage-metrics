import pc from 'picocolors';

import type { UsageReportRow } from '../domain/usage-report-row.js';
import { splitCellLines } from './table-text-layout.js';

export type TextStyler = (text: string) => string;

export type TerminalStylePalette = {
  cyan: TextStyler;
  magenta: TextStyler;
  blue: TextStyler;
  yellow: TextStyler;
  green: TextStyler;
  white: TextStyler;
  bold: TextStyler;
  dim: TextStyler;
};

export const defaultTerminalStylePalette: TerminalStylePalette = {
  cyan: pc.cyan,
  magenta: pc.magenta,
  blue: pc.blue,
  yellow: pc.yellow,
  green: pc.green,
  white: pc.white,
  bold: pc.bold,
  dim: pc.dim,
};

const passthroughStyler: TextStyler = (text) => text;
const periodColumnIndex = 0;
const sourceColumnIndex = 1;
const modelsColumnIndex = 2;
const totalColumnIndex = 8;
const packedModelStartPattern = /(^| {2,})(?=• )/gu;

function styleCellLines(cell: string, styler: TextStyler): string {
  return splitCellLines(cell)
    .map((line) => (line.length === 0 ? '' : styler(line)))
    .join('\n');
}

function styleModelsCell(
  cell: string,
  palette: TerminalStylePalette,
  options: {
    emphasizePrimaryWhenSingleLine?: boolean;
    primaryStyler?: TextStyler;
    secondaryStyler?: TextStyler;
    totalStyler?: TextStyler;
  } = {},
): string {
  const emphasizePrimaryWhenSingleLine = options.emphasizePrimaryWhenSingleLine ?? false;
  const primaryStyler = options.primaryStyler ?? palette.bold;
  const secondaryStyler = options.secondaryStyler ?? passthroughStyler;
  const totalStyler = options.totalStyler ?? ((text) => palette.bold(palette.green(text)));
  const lines = splitCellLines(cell);
  const modelEntryCount = lines.reduce((count, line) => {
    if (line === 'Σ TOTAL') {
      return count;
    }

    const segmentStarts = [...line.matchAll(packedModelStartPattern)];
    return count + segmentStarts.length;
  }, 0);
  const shouldEmphasizePrimary = emphasizePrimaryWhenSingleLine || modelEntryCount > 1;
  let currentStyler = shouldEmphasizePrimary ? primaryStyler : passthroughStyler;
  let modelLineCount = 0;

  return lines
    .map((line) => {
      if (line.length === 0) {
        return '';
      }

      if (line === 'Σ TOTAL') {
        currentStyler = totalStyler;
        return totalStyler(line);
      }

      const segmentStarts = [...line.matchAll(packedModelStartPattern)].map((match) => match.index);

      if (segmentStarts.length === 0) {
        return currentStyler(line);
      }

      const prefix = segmentStarts[0] > 0 ? currentStyler(line.slice(0, segmentStarts[0])) : '';
      let nextContinuationStyler = currentStyler;
      const renderedSegments = segmentStarts
        .map((segmentStart, segmentIndex) => {
          const segmentStyler =
            modelLineCount === 0 && shouldEmphasizePrimary ? primaryStyler : secondaryStyler;
          modelLineCount += 1;
          nextContinuationStyler = segmentStyler;

          const segmentEnd = segmentStarts[segmentIndex + 1] ?? line.length;
          return segmentStyler(line.slice(segmentStart, segmentEnd));
        })
        .join('');

      currentStyler = nextContinuationStyler;
      return prefix + renderedSegments;
    })
    .join('\n');
}

function styleCellAtIndex(cells: string[], index: number, styler: TextStyler): string[] {
  if (index < 0 || index >= cells.length) {
    return cells;
  }

  const styledCells = [...cells];
  styledCells[index] = styleCellLines(styledCells[index], styler);
  return styledCells;
}

type SourceStylePolicy = (palette: TerminalStylePalette) => TextStyler;

const sourceStylePolicies = new Map<string, SourceStylePolicy>([
  ['pi', (palette) => palette.cyan],
  ['codex', (palette) => palette.magenta],
  ['gemini', (palette) => palette.yellow],
  ['droid', (palette) => palette.green],
  ['opencode', (palette) => palette.blue],
]);

export function resolveSourceStyler(
  source: string,
  palette: TerminalStylePalette = defaultTerminalStylePalette,
): TextStyler {
  const stylePolicy = sourceStylePolicies.get(source);

  if (!stylePolicy) {
    return passthroughStyler;
  }

  return stylePolicy(palette);
}

type RowTypeStylePolicy = (cells: string[], palette: TerminalStylePalette) => string[];

function getTrailingColumnIndex(cells: string[]): number | undefined {
  return cells.length === 0 ? undefined : cells.length - 1;
}

const rowTypeStylePolicies: Record<UsageReportRow['rowType'], RowTypeStylePolicy> = {
  period_source: (cells, palette) => {
    let styledCells = [...cells];
    const trailingColumnIndex = getTrailingColumnIndex(styledCells);

    if (modelsColumnIndex < styledCells.length) {
      styledCells[modelsColumnIndex] = styleModelsCell(styledCells[modelsColumnIndex], palette, {
        secondaryStyler: palette.dim,
      });
    }

    styledCells = styleCellAtIndex(styledCells, totalColumnIndex, palette.green);

    if (trailingColumnIndex !== undefined) {
      styledCells = styleCellAtIndex(styledCells, trailingColumnIndex, (line) =>
        palette.bold(palette.yellow(line)),
      );
    }

    return styledCells;
  },
  period_combined: (cells, palette) => {
    let styledCells = [...cells];
    const trailingColumnIndex = getTrailingColumnIndex(styledCells);

    styledCells = styleCellAtIndex(styledCells, periodColumnIndex, palette.white);
    styledCells = styleCellAtIndex(styledCells, sourceColumnIndex, (line) =>
      palette.bold(palette.yellow(line)),
    );

    if (modelsColumnIndex < styledCells.length) {
      styledCells[modelsColumnIndex] = styleModelsCell(styledCells[modelsColumnIndex], palette, {
        secondaryStyler: palette.dim,
      });
    }

    styledCells = styleCellAtIndex(styledCells, totalColumnIndex, (line) =>
      palette.bold(palette.green(line)),
    );

    if (trailingColumnIndex !== undefined) {
      styledCells = styleCellAtIndex(styledCells, trailingColumnIndex, (line) =>
        palette.bold(palette.yellow(line)),
      );
    }

    return styledCells;
  },
  grand_total: (cells, palette) => {
    const styledCells = cells.map((cell, cellIndex) => {
      if (cellIndex === modelsColumnIndex) {
        return cell;
      }

      return styleCellLines(cell, palette.bold);
    });

    if (periodColumnIndex < styledCells.length) {
      styledCells[periodColumnIndex] = styleCellLines(cells[periodColumnIndex], (line) =>
        palette.bold(palette.white(line)),
      );
    }

    if (sourceColumnIndex < styledCells.length) {
      styledCells[sourceColumnIndex] = styleCellLines(cells[sourceColumnIndex], (line) =>
        palette.bold(palette.green(line)),
      );
    }

    if (modelsColumnIndex < styledCells.length) {
      styledCells[modelsColumnIndex] = styleModelsCell(styledCells[modelsColumnIndex], palette, {
        emphasizePrimaryWhenSingleLine: true,
        primaryStyler: (line) => palette.bold(palette.white(line)),
        secondaryStyler: palette.dim,
        totalStyler: (line) => palette.bold(palette.green(line)),
      });
    }

    if (totalColumnIndex < styledCells.length) {
      styledCells[totalColumnIndex] = styleCellLines(cells[totalColumnIndex], (line) =>
        palette.bold(palette.green(line)),
      );
    }

    const trailingColumnIndex = getTrailingColumnIndex(styledCells);

    if (trailingColumnIndex !== undefined) {
      styledCells[trailingColumnIndex] = styleCellLines(cells[trailingColumnIndex], (line) =>
        palette.bold(palette.yellow(line)),
      );
    }

    return styledCells;
  },
};

export function applyRowTypeStyle(
  rowType: UsageReportRow['rowType'],
  cells: string[],
  palette: TerminalStylePalette = defaultTerminalStylePalette,
): string[] {
  return rowTypeStylePolicies[rowType](cells, palette);
}

function applyBaseCellStyle(
  cells: string[],
  palette: TerminalStylePalette,
  sourceStyler: TextStyler,
): string[] {
  if (cells.length < 2) {
    return [...cells];
  }

  const styledCells = [...cells];

  styledCells[0] = styleCellLines(styledCells[0], palette.white);
  styledCells[1] = styleCellLines(styledCells[1], sourceStyler);

  return styledCells;
}

export function colorizeUsageBodyRows(
  bodyRows: string[][],
  rows: UsageReportRow[],
  options: {
    useColor: boolean;
    palette?: TerminalStylePalette;
  },
): string[][] {
  if (!options.useColor) {
    return bodyRows;
  }

  const palette = options.palette ?? defaultTerminalStylePalette;

  return rows.map((row, index) => {
    const bodyRow = bodyRows[index] ?? [];
    const sourceStyler =
      row.rowType === 'period_source'
        ? resolveSourceStyler(String(row.source), palette)
        : passthroughStyler;
    const baseStyledCells =
      row.rowType === 'period_source'
        ? applyBaseCellStyle(bodyRow, palette, sourceStyler)
        : [...bodyRow];

    return applyRowTypeStyle(row.rowType, baseStyledCells, palette);
  });
}
