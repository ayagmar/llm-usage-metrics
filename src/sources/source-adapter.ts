import type { UsageEvent, SourceId } from '../domain/usage-event.js';
import { asRecord } from '../utils/as-record.js';

export type SourceSkippedRowReasonStat = {
  reason: string;
  count: number;
};

export type SourceCapabilities = {
  fixedProviderRoots?: readonly string[];
  /**
   * Every event a file yields is timestamped no later than the newest mtime of the file
   * and its parse dependencies, so a `--since` run may skip files last modified before
   * the window. Leave it unset for SQLite sources: their events live in a shared database
   * whose sidecars and checkpoints do not track when each row was written.
   */
  eventsPrecedeFileMtime?: boolean;
};

export type SourceAdapterPathOptions = {
  dir?: string;
  requireDir?: boolean;
};

export type SourceParseFileDiagnostics<Event extends UsageEvent = UsageEvent> = {
  events: Event[];
  skippedRows: number;
  skippedRowReasons?: SourceSkippedRowReasonStat[];
};

export interface SourceAdapter<Event extends UsageEvent = UsageEvent> {
  readonly id: SourceId;
  /**
   * Bump whenever parsing the same unchanged file would produce different events
   * (token mapping, dedup, model resolution). It is part of the event-store cache key,
   * so a bump re-parses files that were stored by an older parser. Defaults to 1.
   */
  readonly parserVersion?: number;
  readonly capabilities?: SourceCapabilities;
  /** Directories or database files discovery looks in, for `doctor`. */
  getSearchPaths?(): readonly string[];
  discoverFiles(): Promise<string[]>;
  parseFile(filePath: string): Promise<Event[]>;
  parseFileWithDiagnostics?(filePath: string): Promise<SourceParseFileDiagnostics<Event>>;
  getParseDependencies?(filePath: string): Promise<string[]>;
}

export function isSourceAdapter(candidate: unknown): candidate is SourceAdapter {
  const adapter = asRecord(candidate);

  if (!adapter) {
    return false;
  }

  return (
    typeof adapter.id === 'string' &&
    adapter.id.trim().length > 0 &&
    typeof adapter.discoverFiles === 'function' &&
    typeof adapter.parseFile === 'function'
  );
}
