import { asRecord } from '../../utils/as-record.js';
import { asTrimmedText } from '../parsing-utils.js';

export function isBusyOrLockedSqliteError(error: unknown): boolean {
  const asError = asRecord(error);
  const code = asTrimmedText(asError?.code);
  const message = error instanceof Error ? error.message : String(error);
  const busySignal = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/u;

  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === 'ERR_SQLITE_BUSY' ||
    busySignal.test(message)
  );
}

export function formatSqliteError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const errorRecord = asRecord(error);
  const code = asTrimmedText(errorRecord?.code);

  if (!code) {
    return error.message;
  }

  return `${code}: ${error.message}`;
}
