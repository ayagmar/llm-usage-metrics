import type {
  PruneCandidate,
  PruneReportResult,
  PruneSummary,
  StoreSizeSnapshot,
} from '../cli/run-prune-report.js';
import { formatByteSize } from './format-byte-size.js';
import { renderReportHeader } from './report-header.js';
import { renderUnicodeTable, type TableRowMeta } from './unicode-table.js';
import { wrapTableColumn } from './table-text-layout.js';

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
    candidate.filePath,
    String(candidate.eventCount),
    candidate.newestTimestamp ?? '-',
    candidate.reasons.join(', '),
  ]);
  const wrappedRows = wrapTableColumn(bodyRows, { columnIndex: 1, width: 56 });

  return renderUnicodeTable({
    headerCells: ['Source', 'Path', 'Events', 'Newest timestamp', 'Reason'],
    bodyRows: wrappedRows,
    measureHeaderCells: ['Source', 'Path', 'Events', 'Newest timestamp', 'Reason'],
    measureBodyRows: wrappedRows,
    rowMetas: createRowMetas(candidates),
    layout: 'top_aligned',
    multilineColumnIndex: 1,
    multilineColumnWidth: 56,
  });
}

function renderSummary(summary: PruneSummary): string {
  if (!summary.applied) {
    return `Would delete ${summary.candidateFileCount} file(s) / ${summary.candidateEventCount} event(s). Re-run with --apply.`;
  }

  const sizeSuffix =
    summary.sizeBefore && summary.sizeAfter && summary.reclaimedBytes !== undefined
      ? ` Reclaimed ${formatByteSize(summary.reclaimedBytes)} (${formatStoreSize(summary.sizeBefore)} before; ${formatStoreSize(summary.sizeAfter)} after).`
      : '';

  return `Deleted ${summary.deletedFileCount ?? 0} file(s) / ${summary.deletedEventCount ?? 0} event(s).${sizeSuffix}`;
}

export function renderPruneReport(result: PruneReportResult): string {
  const lines: string[] = [
    renderReportHeader({ title: 'Event Store Prune', useColor: false }),
    '',
    renderCandidateTable(result.candidates),
    '',
    renderSummary(result.summary),
  ];

  return lines.join('\n');
}
