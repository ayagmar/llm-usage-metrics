import type { UsageEvent, SourceId } from '../domain/usage-event.js';
import { asRecord } from '../utils/as-record.js';

export type SourceSkippedRowReasonStat = {
  reason: string;
  count: number;
};

export type SourceCapabilities = {
  fixedProviderRoots?: readonly string[];
  requiresExplicitSelection?: boolean;
};

export type SourceParseFileDiagnostics<Event extends UsageEvent = UsageEvent> = {
  events: Event[];
  skippedRows: number;
  skippedRowReasons?: SourceSkippedRowReasonStat[];
  sourceItemsFound?: number;
};

export interface SourceAdapter<Event extends UsageEvent = UsageEvent> {
  readonly id: SourceId;
  readonly capabilities?: SourceCapabilities;
  discoverFiles(): Promise<string[]>;
  parseFile(filePath: string): Promise<Event[]>;
  parseFileWithDiagnostics?(filePath: string): Promise<SourceParseFileDiagnostics<Event>>;
  parseSourceWithDiagnostics?(): Promise<SourceParseFileDiagnostics<Event>>;
  getParseDependencies?(filePath: string): Promise<string[]>;
}

export function isSourceAdapter(candidate: unknown): candidate is SourceAdapter {
  const adapter = asRecord(candidate);

  if (!adapter) {
    return false;
  }

  if (typeof adapter.id !== 'string' || adapter.id.trim().length === 0) {
    return false;
  }

  const hasFileBackedParser =
    typeof adapter.discoverFiles === 'function' && typeof adapter.parseFile === 'function';
  const hasSourceParser = typeof adapter.parseSourceWithDiagnostics === 'function';

  return hasFileBackedParser || hasSourceParser;
}
