import type { UsageEvent } from '../domain/usage-event.js';
import type { EventStoreFileSnapshot } from '../persistence/event-store.js';
import { asRecord } from '../utils/as-record.js';

/**
 * A machine export is NDJSON: one header line, a `file` line for each counted file the
 * reader does not already hold at the same revision, and an `end` line that lists every
 * counted file. A stream without its `end` line is incomplete and must be discarded.
 */
export const MACHINE_EXPORT_FORMAT = 'llm-usage-metrics.machine-export';
export const MACHINE_EXPORT_VERSION = 1;

/** [source, filePath, revision] */
export type MachineExportFileKey = [source: string, filePath: string, revision: string];

export type MachineExportHeaderLine = {
  type: 'header';
  format: typeof MACHINE_EXPORT_FORMAT;
  version: typeof MACHINE_EXPORT_VERSION;
  cliVersion: string;
  hostname: string;
  exportedAt: string;
};

export type MachineExportFileLine = {
  type: 'file';
  source: string;
  filePath: string;
  revision: string;
  events: UsageEvent[];
};

export type MachineExportEndLine = {
  type: 'end';
  files: MachineExportFileKey[];
  eventCount: number;
};

export type MachineExportLine =
  MachineExportHeaderLine | MachineExportFileLine | MachineExportEndLine;

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toFileKey(source: string, filePath: string): string {
  return JSON.stringify([source, filePath]);
}

/**
 * Parses the files a reader already holds, as written by a previous sync:
 * `{"version":1,"files":[[source, filePath, revision], ...]}`.
 */
export function parseKnownFiles(text: string): Map<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('Known files must be JSON', { cause: error });
  }

  const record = asRecord(parsed);

  if (record?.version !== MACHINE_EXPORT_VERSION || !Array.isArray(record.files)) {
    throw new Error(
      `Known files must be {"version":${MACHINE_EXPORT_VERSION},"files":[[source, filePath, revision], ...]}`,
    );
  }

  const knownFiles = new Map<string, string>();

  for (const entry of record.files) {
    const [source, filePath, revision] = Array.isArray(entry) ? (entry as unknown[]) : [];

    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      !isNonEmptyText(source) ||
      !isNonEmptyText(filePath) ||
      !isNonEmptyText(revision)
    ) {
      throw new Error('Each known file must be [source, filePath, revision]');
    }

    knownFiles.set(toFileKey(source, filePath), revision);
  }

  return knownFiles;
}

/**
 * Lays out an export of `snapshots`, leaving out the events of files the reader already
 * holds at the same revision. Files without events are not counted, so they are omitted.
 */
export function buildMachineExportLines(
  header: Omit<MachineExportHeaderLine, 'type' | 'format' | 'version'>,
  snapshots: readonly EventStoreFileSnapshot[],
  knownFiles: ReadonlyMap<string, string> = new Map(),
): MachineExportLine[] {
  const lines: MachineExportLine[] = [
    { type: 'header', format: MACHINE_EXPORT_FORMAT, version: MACHINE_EXPORT_VERSION, ...header },
  ];
  const files: MachineExportFileKey[] = [];
  let eventCount = 0;

  for (const snapshot of snapshots) {
    if (snapshot.events.length === 0) {
      continue;
    }

    files.push([snapshot.source, snapshot.filePath, snapshot.revision]);
    eventCount += snapshot.events.length;

    if (knownFiles.get(toFileKey(snapshot.source, snapshot.filePath)) === snapshot.revision) {
      continue;
    }

    lines.push({
      type: 'file',
      source: snapshot.source,
      filePath: snapshot.filePath,
      revision: snapshot.revision,
      events: snapshot.events,
    });
  }

  lines.push({ type: 'end', files, eventCount });
  return lines;
}
