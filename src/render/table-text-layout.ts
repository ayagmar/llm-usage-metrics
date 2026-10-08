const ansiEscapePattern = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'gu');
const combiningMarkPattern = /\p{Mark}/u;
const extendedPictographicPattern = /\p{Extended_Pictographic}/u;
const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const regionalIndicatorPattern = /\p{Regional_Indicator}/u;
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export type TerminalColumnsSource = {
  isTTY?: unknown;
  columns?: unknown;
};

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

export function resolveTtyColumns(source: TerminalColumnsSource): number | undefined {
  if (source.isTTY !== true) {
    return undefined;
  }

  if (
    typeof source.columns !== 'number' ||
    !Number.isFinite(source.columns) ||
    source.columns <= 0
  ) {
    return undefined;
  }

  return Math.floor(source.columns);
}

function stripAnsi(value: string): string {
  return value.replaceAll(ansiEscapePattern, '');
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  );
}

// Adapted from the is-fullwidth-code-point package to preserve table alignment
// for East Asian wide characters without re-introducing a dependency.
const fullWidthCodePointRanges = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b001],
  [0x1f200, 0x1f251],
  [0x20000, 0x3fffd],
] as const;

const fullWidthCodePointExclusions = new Set<number>([0x303f]);

function isFullWidthCodePoint(codePoint: number): boolean {
  if (Number.isNaN(codePoint) || fullWidthCodePointExclusions.has(codePoint)) {
    return false;
  }

  for (const [start, end] of fullWidthCodePointRanges) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }

  return false;
}

function codePointDisplayWidth(character: string): number {
  const codePoint = character.codePointAt(0);

  if (codePoint === undefined) {
    return 0;
  }

  if (isControlCodePoint(codePoint) || isZeroWidthCodePoint(codePoint)) {
    return 0;
  }

  if (combiningMarkPattern.test(character)) {
    return 0;
  }

  if (isFullWidthCodePoint(codePoint)) {
    return 2;
  }

  return 1;
}

function segmentGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment);
}

function isEmojiGrapheme(grapheme: string): boolean {
  if (emojiPresentationPattern.test(grapheme)) {
    return true;
  }

  if (regionalIndicatorPattern.test(grapheme)) {
    return true;
  }

  if (grapheme.includes('\u20E3')) {
    return true;
  }

  if (grapheme.includes('\uFE0F')) {
    return true;
  }

  return grapheme.includes('\u200D') && extendedPictographicPattern.test(grapheme);
}

function graphemeDisplayWidth(grapheme: string): number {
  if (isEmojiGrapheme(grapheme)) {
    return 2;
  }

  let width = 0;

  for (const character of grapheme) {
    width = Math.max(width, codePointDisplayWidth(character));
  }

  return width;
}

export function visibleWidth(value: string): number {
  let width = 0;

  for (const grapheme of segmentGraphemes(stripAnsi(value))) {
    width += graphemeDisplayWidth(grapheme);
  }

  return width;
}

export function splitCellLines(value: string): string[] {
  return normalizeLineBreaks(value).split('\n');
}

function sliceByVisibleWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }

  let width = 0;
  let endOffset = 0;

  for (const grapheme of segmentGraphemes(value)) {
    const graphemeWidth = graphemeDisplayWidth(grapheme);

    if (width + graphemeWidth > maxWidth) {
      break;
    }

    width += graphemeWidth;
    endOffset += grapheme.length;
  }

  return value.slice(0, endOffset);
}

function getFirstGrapheme(value: string): string {
  for (const grapheme of segmentGraphemes(value)) {
    return grapheme;
  }

  return '';
}

function wrapPlainLine(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) {
    return [line];
  }

  const wrappedLines: string[] = [];
  let remaining = line;

  while (visibleWidth(remaining) > width) {
    const slice = sliceByVisibleWidth(remaining, width + 1);
    const breakIndex = slice.lastIndexOf(' ');

    if (breakIndex > 0) {
      wrappedLines.push(remaining.slice(0, breakIndex));
      remaining = remaining.slice(breakIndex + 1);
      continue;
    }

    const chunk = sliceByVisibleWidth(remaining, width);

    if (chunk.length > 0) {
      wrappedLines.push(chunk);
      remaining = remaining.slice(chunk.length);
      continue;
    }

    const firstCharacter = getFirstGrapheme(remaining);

    wrappedLines.push(firstCharacter);
    remaining = remaining.slice(firstCharacter.length);
  }

  wrappedLines.push(remaining);

  return wrappedLines;
}

export function wrapTableColumn(
  rows: string[][],
  options: { columnIndex: number; width: number },
): string[][] {
  if (options.width <= 0) {
    throw new RangeError('wrapTableColumn width must be greater than 0');
  }

  return rows.map((row) => {
    const wrappedRow = [...row];
    const cell = wrappedRow[options.columnIndex] ?? '';
    const wrappedLines = splitCellLines(cell).flatMap((line) => wrapPlainLine(line, options.width));

    wrappedRow[options.columnIndex] = wrappedLines.join('\n');

    return wrappedRow;
  });
}

function takeGraphemesByVisibleWidth(graphemes: readonly string[], maxWidth: number): string[] {
  const taken: string[] = [];
  let width = 0;

  for (const grapheme of graphemes) {
    const graphemeWidth = graphemeDisplayWidth(grapheme);

    if (width + graphemeWidth > maxWidth) {
      break;
    }

    width += graphemeWidth;
    taken.push(grapheme);
  }

  return taken;
}

/**
 * Shortens a plain line to `width` by replacing its middle with `…`, so both the start
 * and the distinguishing end (a model's size, effort, or date suffix) stay readable.
 */
export function truncateMiddle(line: string, width: number): string {
  if (visibleWidth(line) <= width) {
    return line;
  }

  if (width <= 1) {
    return '…'.slice(0, Math.max(0, width));
  }

  const graphemes = segmentGraphemes(line);
  const headWidth = Math.ceil((width - 1) / 2);
  const tailWidth = width - 1 - headWidth;
  const head = takeGraphemesByVisibleWidth(graphemes, headWidth);
  const tail = takeGraphemesByVisibleWidth([...graphemes].reverse(), tailWidth).reverse();

  return `${head.join('')}…${tail.join('')}`;
}

export function truncateTableColumn(
  rows: string[][],
  options: { columnIndex: number; width: number },
): string[][] {
  return rows.map((row) => {
    const truncatedRow = [...row];
    const cell = truncatedRow[options.columnIndex] ?? '';

    truncatedRow[options.columnIndex] = splitCellLines(cell)
      .map((line) => truncateMiddle(line, options.width))
      .join('\n');

    return truncatedRow;
  });
}
