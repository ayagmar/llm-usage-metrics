/** Sparkline glyphs by level: a space for no usage, then the eighth blocks up to the peak. */
export const SPARKLINE_GLYPHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** The level of the peak value on a one-row sparkline. */
export const SPARKLINE_TOP_LEVEL = 8;

/**
 * Shrinks `values` to `maxColumns` columns, each the peak of the values it covers, so a spike
 * survives downsampling. Values that already fit are returned as they are.
 */
export function downsamplePeaks(values: readonly number[], maxColumns: number): number[] {
  if (maxColumns <= 0 || values.length <= maxColumns) {
    return [...values];
  }

  return Array.from({ length: maxColumns }, (_, columnIndex) => {
    const startIndex = Math.floor((columnIndex * values.length) / maxColumns);
    const endIndex = Math.floor(((columnIndex + 1) * values.length) / maxColumns);

    return Math.max(0, ...values.slice(startIndex, Math.max(startIndex + 1, endIndex)));
  });
}

/**
 * The level of `value` on a scale from 0 to `topLevel`, where `maxValue` is the top. Any
 * positive value gets at least level 1, so light usage still shows.
 */
export function sparklineLevel(
  value: number,
  maxValue: number,
  topLevel: number = SPARKLINE_TOP_LEVEL,
): number {
  if (value <= 0 || maxValue <= 0) {
    return 0;
  }

  return Math.max(1, Math.min(topLevel, Math.round((value / maxValue) * topLevel)));
}

/** One glyph per value, downsampled to `maxColumns` and scaled to the largest value. */
export function renderSparkline(values: readonly number[], maxColumns: number): string {
  const columns = downsamplePeaks(values, maxColumns);
  const maxValue = Math.max(0, ...columns);

  return columns.map((value) => SPARKLINE_GLYPHS[sparklineLevel(value, maxValue)]).join('');
}
