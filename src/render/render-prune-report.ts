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
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { resolveTtyColumns, wrapTableColumn } from './table-text-layout.js';

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

function renderCandidateTable(candidates: readonly PruneCandidate[]): string {
  const bodyRows = candidates.map((candidate) => [
    candidate.source,
    stripControlCharacters(candidate.filePath),
    formatInteger(candidate.eventCount),
    candidate.newestTimestamp ?? '-',
    candidate.reasons.join(', '),
  ]);
  const wrappedRows = wrapTableColumn(bodyRows, { columnIndex: 1, width: 56 });

  return renderUnicodeTable({
    headerCells: ['Source', 'Path', 'Events', 'Newest timestamp', 'Reason'],
    bodyRows: wrappedRows,
    measureHeaderCells: ['Source', 'Path', 'Events', 'Newest timestamp', 'Reason'],
    measureBodyRows: bodyRows,
    rowMetas: createRowMetas(candidates),
    columnKinds: ['text', 'text', 'measure', 'text', 'text'],
    multilineColumnIndex: 1,
    multilineColumnWidth: 56,
    terminalWidth: resolveTtyColumns(process.stdout),
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

export function renderPruneReport(result: PruneReportResult): string {
  const header = renderReportHeader({ title: 'Event Store Prune', useColor: false });
  const departedFiles = result.summary.departedFiles;
  const lines: string[] = departedFiles
    ? [header, '', ...renderDepartedFileCounts(departedFiles)]
    : [header, '', renderCandidateTable(result.candidates), '', renderSummary(result.summary)];

  return lines.join('\n');
}
