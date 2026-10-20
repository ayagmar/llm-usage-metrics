import type {
  PruneCandidate,
  PruneDepartedFileCounts,
  PruneReportResult,
  PruneSummary,
  StoreSizeSnapshot,
} from '../cli/run-prune-report.js';
import { pluralize, stripControlCharacters } from '@ayagmar/agent-sessions/internal';
import { formatByteSize } from './format-byte-size.js';
import { formatInteger } from './format-number.js';
import { renderReportHeader } from './report-header.js';
import {
  createColorRoles,
  type ColorRoles,
  type TerminalStylePalette,
} from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';
import {
  describeTableFit,
  type RenderedReportWithNotes,
  type TableFitChanges,
} from './table-fit-note.js';
import { renderUnicodeTableWithFit, type TableRowMeta, wrapAtNameBreaks } from './unicode-table.js';
import { measureCellWidth, resolveTtyColumns, wrapProse } from './table-text-layout.js';

export type RenderPruneReportOptions = {
  useColor?: boolean;
  /** Defaults to the stdout TTY width; without one (piped output) paths are not wrapped. */
  terminalWidth?: number;
  palette?: TerminalStylePalette;
};

const headerCells = ['Source', 'Path', 'Events', 'Newest Timestamp', 'Reason'];
const pathColumnIndex = 1;
const timestampColumnIndex = 3;
// Narrower than this, a wrapped path is more breaks than path, so rows are listed instead.
const minPathColumnWidth = 24;

function formatStoreSize(size: StoreSizeSnapshot): string {
  return [
    `${formatByteSize(size.totalBytes)} total`,
    `db ${formatByteSize(size.databaseBytes)}`,
    `wal ${formatByteSize(size.walBytes)}`,
    `shm ${formatByteSize(size.shmBytes)}`,
  ].join(', ');
}

function createRowMetas(candidates: readonly PruneCandidate[]): TableRowMeta[] {
  return candidates.map((candidate) => ({
    periodKey: candidate.source,
    rowKind: 'detail',
  }));
}

/**
 * The width to wrap paths at, or undefined when they fit whole. The table hides the
 * timestamp column before a path wraps, so the width is what is left without it.
 */
function resolvePathWrapWidth(
  bodyRows: readonly string[][],
  terminalWidth: number | undefined,
): number | undefined {
  if (terminalWidth === undefined) {
    return undefined;
  }

  const widths = headerCells.map((header, columnIndex) =>
    bodyRows.reduce(
      (width, row) => Math.max(width, measureCellWidth(row[columnIndex])),
      measureCellWidth(header),
    ),
  );
  // Each column adds its two padding spaces and one border; the box adds one more border.
  const otherColumnsWidth = widths.reduce(
    (total, width, columnIndex) =>
      columnIndex === pathColumnIndex || columnIndex === timestampColumnIndex
        ? total
        : total + width + 3,
    1 + 3,
  );
  const availablePathWidth = terminalWidth - otherColumnsWidth;

  return availablePathWidth >= widths[pathColumnIndex]
    ? undefined
    : Math.max(minPathColumnWidth, availablePathWidth);
}

function colorizeRow(row: readonly string[], source: string, roles: ColorRoles): string[] {
  return row.map((cell, columnIndex) => {
    if (columnIndex === 0) {
      return roles.source(source)(cell);
    }

    return cell === '-' ? roles.dim(cell) : cell;
  });
}

function renderCandidateTable(
  candidates: readonly PruneCandidate[],
  roles: ColorRoles,
  terminalWidth: number | undefined,
): { output: string; fit: TableFitChanges } {
  const bodyRows = candidates.map((candidate) => [
    candidate.source,
    stripControlCharacters(candidate.filePath),
    formatInteger(candidate.eventCount),
    candidate.newestTimestamp ?? '-',
    candidate.reasons.join(', '),
  ]);
  const pathWrapWidth = resolvePathWrapWidth(bodyRows, terminalWidth);
  const wrappedRows =
    pathWrapWidth === undefined
      ? bodyRows
      : bodyRows.map((row) =>
          row.map((cell, columnIndex) =>
            columnIndex === pathColumnIndex
              ? wrapAtNameBreaks(cell, pathWrapWidth).join('\n')
              : cell,
          ),
        );

  return renderUnicodeTableWithFit({
    headerCells: headerCells.map((cell) => roles.header(cell)),
    bodyRows: wrappedRows.map((row, rowIndex) =>
      colorizeRow(row, candidates[rowIndex].source, roles),
    ),
    measureHeaderCells: headerCells,
    measureBodyRows: bodyRows,
    rowMetas: createRowMetas(candidates),
    columnKinds: ['text', 'text', 'measure', 'text', 'text'],
    multilineColumnIndex: pathColumnIndex,
    multilineColumnWidth: pathWrapWidth,
    terminalWidth,
    fit: { hideableColumns: [timestampColumnIndex] },
  });
}

function renderSummary(summary: PruneSummary): string {
  if (!summary.applied) {
    return `Would delete ${describeFiles(summary.candidateFileCount, summary.candidateEventCount)}. Re-run with --apply.`;
  }

  const sizeSuffix =
    summary.sizeBefore && summary.sizeAfter && summary.reclaimedBytes !== undefined
      ? ` Reclaimed ${formatByteSize(summary.reclaimedBytes)} (${formatStoreSize(summary.sizeBefore)} before; ${formatStoreSize(summary.sizeAfter)} after).`
      : '';

  return `Deleted ${describeFiles(summary.deletedFileCount ?? 0, summary.deletedEventCount ?? 0)}.${sizeSuffix}`;
}

function describeFiles(fileCount: number, eventCount: number): string {
  return `${pluralize(fileCount, 'file')} / ${pluralize(eventCount, 'event')}`;
}

// A run without a selector: what each selector would pick.
function renderDepartedFileCounts(counts: PruneDepartedFileCounts): string[] {
  if (counts.fileCount === 0) {
    return ['No departed files in the event store.'];
  }

  return [
    `Departed: ${describeFiles(counts.fileCount, counts.eventCount)}; suppressed by --history: ${describeFiles(counts.suppressedFileCount, counts.suppressedEventCount)}.`,
    'Preview with --suppressed or --departed-before YYYY-MM-DD, then add --apply to delete.',
  ];
}

export function renderPruneReportWithNotes(
  result: PruneReportResult,
  options: RenderPruneReportOptions = {},
): RenderedReportWithNotes {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = options.terminalWidth ?? resolveTtyColumns(process.stdout);
  const roles = createColorRoles(useColor, options.palette);
  const header = renderReportHeader({ title: 'Event Store Prune', useColor, terminalWidth });
  const departedFiles = result.summary.departedFiles;

  if (departedFiles) {
    return {
      output: [
        header,
        '',
        ...renderDepartedFileCounts(departedFiles).map((line) => wrapProse(line, terminalWidth)),
      ].join('\n'),
      notes: [],
    };
  }

  const table =
    result.candidates.length === 0
      ? undefined
      : renderCandidateTable(result.candidates, roles, terminalWidth);
  const fitNote = table ? describeTableFit(table.fit) : undefined;
  const lines: string[] = [header, '', table ? table.output : 'No files to prune.'];

  // With nothing found, a dry run has nothing to add to that line.
  if (result.candidates.length > 0 || result.summary.applied) {
    lines.push('', wrapProse(renderSummary(result.summary), terminalWidth));
  }

  return { output: lines.join('\n'), notes: fitNote ? [fitNote] : [] };
}

export function renderPruneReport(
  result: PruneReportResult,
  options: RenderPruneReportOptions = {},
): string {
  return renderPruneReportWithNotes(result, options).output;
}
