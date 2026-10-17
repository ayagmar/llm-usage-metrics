import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type {
  SourceParseFileDiagnostics,
  SourceReadDiagnostics,
  SourceSkippedRowReasonStat,
} from './source-adapter.js';

export function incrementSkippedReason(reasons: Map<string, number>, reason: string): void {
  const current = reasons.get(reason) ?? 0;
  reasons.set(reason, current + 1);
}

/** An empty sink to pass as `diagnostics` to a read. */
export function createReadDiagnostics(): SourceReadDiagnostics {
  return { skippedRows: 0, skippedRowReasons: new Map() };
}

export function recordSkippedRow(diagnostics: SourceReadDiagnostics, reason: string): void {
  diagnostics.skippedRows++;
  incrementSkippedReason(diagnostics.skippedRowReasons, reason);
}

function toSkippedRowReasonStats(reasons: Map<string, number>): SourceSkippedRowReasonStat[] {
  return [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => compareByCodePoint(left.reason, right.reason));
}

/** Packs a file's events and skipped-row counts into `SourceParseFileDiagnostics`, reasons sorted. */
export function toParseDiagnostics<Event extends UsageEvent>(
  events: Event[],
  skippedRows: number,
  skippedRowReasons: Map<string, number>,
): SourceParseFileDiagnostics<Event> {
  return {
    events,
    skippedRows,
    skippedRowReasons: toSkippedRowReasonStats(skippedRowReasons),
  };
}
