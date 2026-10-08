import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type { SourceParseFileDiagnostics, SourceSkippedRowReasonStat } from './source-adapter.js';

export function incrementSkippedReason(reasons: Map<string, number>, reason: string): void {
  const current = reasons.get(reason) ?? 0;
  reasons.set(reason, current + 1);
}

function toSkippedRowReasonStats(reasons: Map<string, number>): SourceSkippedRowReasonStat[] {
  return [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => compareByCodePoint(left.reason, right.reason));
}

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
