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
  red: TextStyler;
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
  red: pc.red,
  white: pc.white,
  bold: pc.bold,
  dim: pc.dim,
};

const passthroughStyler: TextStyler = (text) => text;
const sourceColumnIndex = 1;
const modelsColumnIndex = 2;
// Matches only at the start of a space run, so long runs without a bullet stay linear.
const packedModelStartPattern = /(?:^|(?<! ) {2,})(?=• )/gu;

function styleCellLines(cell: string, styler: TextStyler): string {
  return splitCellLines(cell)
    .map((line) => (line.length === 0 ? '' : styler(line)))
    .join('\n');
}

function styleModelsCell(
  cell: string,
  palette: TerminalStylePalette,
  options: { emphasizePrimaryWhenSingleLine?: boolean } = {},
): string {
  const emphasizePrimaryWhenSingleLine = options.emphasizePrimaryWhenSingleLine ?? false;
  const primaryStyler = palette.bold;
  const secondaryStyler = palette.dim;
  const totalStyler = palette.bold;
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

// Yellow, green and red mean money and good/bad, which leaves three hues. They go to the
// sources most often shown side by side; every other source stays uncolored rather than
// sharing a hue.
const sourceStylePolicies = new Map<string, SourceStylePolicy>([
  ['pi', (palette) => palette.cyan],
  ['codex', (palette) => palette.magenta],
  ['claude', (palette) => palette.blue],
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

/** One styler per meaning, so every renderer colors the same kind of text the same way. */
export type ColorRoles = {
  /** Table header cells: bold, the same for every column. */
  header: TextStyler;
  /** Labels in stacked lists and stat lines. */
  label: TextStyler;
  /** Values next to a label, and token measures: the terminal's default color. */
  value: TextStyler;
  /** Cost cells and cost stats. */
  money: TextStyler;
  /** Cost on a total row. */
  moneyTotal: TextStyler;
  /** A change in the good direction, such as savings or a cost decrease. */
  positive: TextStyler;
  /** A change in the bad direction, such as a cost increase. */
  negative: TextStyler;
  /** Warning lines and failed-sync notes. */
  warning: TextStyler;
  /** Secondary text: secondary models, idle cells, footnotes. */
  dim: TextStyler;
  /** The hue for a source name; unknown sources stay uncolored. */
  source: (source: string) => TextStyler;
};

const uncoloredRoles: ColorRoles = {
  header: passthroughStyler,
  label: passthroughStyler,
  value: passthroughStyler,
  money: passthroughStyler,
  moneyTotal: passthroughStyler,
  positive: passthroughStyler,
  negative: passthroughStyler,
  warning: passthroughStyler,
  dim: passthroughStyler,
  source: () => passthroughStyler,
};

/** Without color every role returns its text unchanged, so NO_COLOR output has no escapes. */
export function createColorRoles(
  useColor: boolean,
  palette: TerminalStylePalette = defaultTerminalStylePalette,
): ColorRoles {
  if (!useColor) {
    return uncoloredRoles;
  }

  return {
    header: palette.bold,
    label: palette.dim,
    value: passthroughStyler,
    money: palette.yellow,
    moneyTotal: (text) => palette.bold(palette.yellow(text)),
    positive: palette.green,
    negative: palette.red,
    warning: palette.yellow,
    dim: palette.dim,
    source: (source) => resolveSourceStyler(source, palette),
  };
}

type RowTypeStylePolicy = (cells: string[], palette: TerminalStylePalette) => string[];

/** The cost column is last, so a short row still styles its cost. */
function styleCostCell(cells: string[], styler: TextStyler): string[] {
  return styleCellAtIndex(cells, cells.length - 1, styler);
}

/** Bold primary model and dim secondary models when a row lists several. */
function styleModelsColumn(
  cells: string[],
  palette: TerminalStylePalette,
  options: { emphasizePrimaryWhenSingleLine?: boolean } = {},
): string[] {
  if (modelsColumnIndex >= cells.length) {
    return cells;
  }

  const styledCells = [...cells];
  styledCells[modelsColumnIndex] = styleModelsCell(cells[modelsColumnIndex], palette, options);
  return styledCells;
}

// Token measures keep the terminal's default color. Detail rows show their cost as money;
// a period's combined row and the TOTAL row show bold money and a bold label.
const rowTypeStylePolicies: Record<UsageReportRow['rowType'], RowTypeStylePolicy> = {
  period_source: (cells, palette) =>
    styleCostCell(styleModelsColumn(cells, palette), createColorRoles(true, palette).money),
  period_combined: (cells, palette) =>
    styleCostCell(
      styleModelsColumn(styleCellAtIndex(cells, sourceColumnIndex, palette.bold), palette),
      createColorRoles(true, palette).moneyTotal,
    ),
  grand_total: (cells, palette) => {
    const costColumnIndex = cells.length - 1;
    const boldCells = cells.map((cell, cellIndex) =>
      cellIndex === modelsColumnIndex || cellIndex === costColumnIndex
        ? cell
        : styleCellLines(cell, palette.bold),
    );

    return styleCostCell(
      styleModelsColumn(boldCells, palette, { emphasizePrimaryWhenSingleLine: true }),
      createColorRoles(true, palette).moneyTotal,
    );
  },
};

export function applyRowTypeStyle(
  rowType: UsageReportRow['rowType'],
  cells: string[],
  palette: TerminalStylePalette = defaultTerminalStylePalette,
): string[] {
  return rowTypeStylePolicies[rowType](cells, palette);
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
    const styledCells =
      row.rowType === 'period_source'
        ? styleCellAtIndex(bodyRow, sourceColumnIndex, resolveSourceStyler(row.source, palette))
        : bodyRow;

    return applyRowTypeStyle(row.rowType, styledCells, palette);
  });
}

/**
 * Colors a delta by direction: an increase is positive (green) and a decrease negative
 * (red), or the reverse with `lowerIsBetter`, as for cost. Zero is dim; plain without color.
 */
export function styleDeltaCell(
  value: number | undefined,
  formattedValue: string,
  useColor: boolean,
  options: { lowerIsBetter?: boolean; palette?: TerminalStylePalette } = {},
): string {
  if (!useColor || value === undefined) {
    return formattedValue;
  }

  const roles = createColorRoles(true, options.palette);

  const direction = options.lowerIsBetter === true ? -value : value;

  if (direction > 0) {
    return roles.positive(formattedValue);
  }

  if (direction < 0) {
    return roles.negative(formattedValue);
  }

  return roles.dim(formattedValue);
}
