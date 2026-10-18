import type { SourceSkippedRowReasonStat } from '@ayagmar/agent-sessions';
import { asRecord } from '@ayagmar/agent-sessions/internal';

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.trunc(value);
}

export function normalizeSkippedRowReasons(value: unknown): SourceSkippedRowReasonStat[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asRecord(entry);

    if (!record) {
      return [];
    }

    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    const count = toPositiveInteger(record.count);

    if (!reason || count === undefined) {
      return [];
    }

    return [{ reason, count }];
  });
}
