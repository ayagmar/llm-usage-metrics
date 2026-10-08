import { createUsageEvent, type UsageEvent, type UsageEventInput } from '../domain/usage-event.js';
import type { EventStoreFileSnapshot } from '../persistence/event-store.js';
import { asRecord } from '../utils/as-record.js';
import { getErrorReason } from '../utils/get-error-reason.js';

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

export function toFileKey(source: string, filePath: string): string {
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

export type ParsedMachineExport = {
  header: MachineExportHeaderLine;
  /** Files whose events were sent, in bundle order. */
  sentFiles: MachineExportFileLine[];
  /** Every counted file, sent or not. */
  files: MachineExportFileKey[];
  eventCount: number;
};

function parseBundleLine(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`line ${lineNumber} is not JSON`, { cause: error });
  }

  const record = asRecord(parsed);

  if (!record) {
    throw new Error(`line ${lineNumber} is not an object`);
  }

  return record;
}

function readHeader(record: Record<string, unknown>): MachineExportHeaderLine {
  if (record.type !== 'header' || record.format !== MACHINE_EXPORT_FORMAT) {
    throw new Error('the output is not a machine export (no header line)');
  }

  if (record.version !== MACHINE_EXPORT_VERSION) {
    throw new Error(
      `it exports bundle version ${String(record.version)}, but this llm-usage-metrics reads version ${MACHINE_EXPORT_VERSION}; install the same version on both machines`,
    );
  }

  return {
    type: 'header',
    format: MACHINE_EXPORT_FORMAT,
    version: MACHINE_EXPORT_VERSION,
    cliVersion: typeof record.cliVersion === 'string' ? record.cliVersion : '',
    hostname: typeof record.hostname === 'string' ? record.hostname : '',
    exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
  };
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${key} is not a string`);
  }

  return value;
}

function optionalCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error(`${key} is not a non-negative number`);
  }

  return value;
}

/** Events are the same objects `events --format jsonl` prints; wrong types are rejected. */
function toUsageEventInput(value: unknown): UsageEventInput {
  const record = asRecord(value);

  if (!record) {
    throw new Error('not an object');
  }

  const costMode = record.costMode;

  if (costMode !== 'explicit' && costMode !== 'estimated') {
    throw new Error('costMode is not explicit or estimated');
  }

  return {
    source: optionalText(record, 'source') ?? '',
    sessionId: optionalText(record, 'sessionId') ?? '',
    timestamp: optionalText(record, 'timestamp') ?? '',
    repoRoot: optionalText(record, 'repoRoot'),
    provider: optionalText(record, 'provider'),
    model: optionalText(record, 'model'),
    inputTokens: optionalCount(record, 'inputTokens'),
    outputTokens: optionalCount(record, 'outputTokens'),
    reasoningTokens: optionalCount(record, 'reasoningTokens'),
    cacheReadTokens: optionalCount(record, 'cacheReadTokens'),
    cacheWriteTokens: optionalCount(record, 'cacheWriteTokens'),
    totalTokens: optionalCount(record, 'totalTokens'),
    costUsd: optionalCount(record, 'costUsd'),
    costMode,
  };
}

function readFileLine(record: Record<string, unknown>, lineNumber: number): MachineExportFileLine {
  const { source, filePath, revision, events } = record;

  if (
    !isNonEmptyText(source) ||
    !isNonEmptyText(filePath) ||
    !isNonEmptyText(revision) ||
    !Array.isArray(events) ||
    events.length === 0
  ) {
    throw new Error(`line ${lineNumber} is not a valid file line`);
  }

  return {
    type: 'file',
    source,
    filePath,
    revision,
    events: events.map((event: unknown, index) => {
      try {
        const usageEvent = createUsageEvent(toUsageEventInput(event));

        if (usageEvent.source !== source) {
          throw new Error(`its source is ${usageEvent.source}, not ${source}`);
        }

        return usageEvent;
      } catch (error) {
        throw new Error(
          `line ${lineNumber} has an invalid event at index ${index}: ${getErrorReason(error)}`,
          { cause: error },
        );
      }
    }),
  };
}

function readEndLine(record: Record<string, unknown>, lineNumber: number): MachineExportEndLine {
  const { files, eventCount } = record;

  if (
    !Array.isArray(files) ||
    typeof eventCount !== 'number' ||
    !Number.isSafeInteger(eventCount) ||
    eventCount < 0
  ) {
    throw new Error(`line ${lineNumber} is not a valid end line`);
  }

  const fileKeys = files.map((entry: unknown): MachineExportFileKey => {
    const [source, filePath, revision] = Array.isArray(entry) ? (entry as unknown[]) : [];

    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      !isNonEmptyText(source) ||
      !isNonEmptyText(filePath) ||
      !isNonEmptyText(revision)
    ) {
      throw new Error(`line ${lineNumber} lists an invalid file`);
    }

    return [source, filePath, revision];
  });

  return { type: 'end', files: fileKeys, eventCount };
}

/**
 * Reads and validates a machine export. It throws unless the bundle is complete and
 * self-consistent: every sent file is listed once at the sent revision.
 */
export async function readMachineExport(
  lines: AsyncIterable<string>,
): Promise<ParsedMachineExport> {
  let header: MachineExportHeaderLine | undefined;
  let end: MachineExportEndLine | undefined;
  const sentFiles: MachineExportFileLine[] = [];
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;

    if (line.trim().length === 0) {
      continue;
    }

    if (end) {
      throw new Error(`line ${lineNumber} follows the end line`);
    }

    if (!header) {
      // A shell startup file may print text before the command's own output.
      if (line.includes(`"${MACHINE_EXPORT_FORMAT}"`)) {
        header = readHeader(parseBundleLine(line, lineNumber));
      }

      continue;
    }

    const record = parseBundleLine(line, lineNumber);

    if (record.type === 'file') {
      sentFiles.push(readFileLine(record, lineNumber));
    } else if (record.type === 'end') {
      end = readEndLine(record, lineNumber);
    } else {
      throw new Error(`line ${lineNumber} has an unknown type`);
    }
  }

  if (!header) {
    throw new Error('the output is not a machine export (no header line)');
  }

  if (!end) {
    throw new Error('the export ended early (no end line)');
  }

  const listedRevisions = new Map<string, string>();

  for (const [source, filePath, revision] of end.files) {
    const key = toFileKey(source, filePath);

    if (listedRevisions.has(key)) {
      throw new Error(`the end line lists ${filePath} twice`);
    }

    listedRevisions.set(key, revision);
  }

  const sentKeys = new Set<string>();

  for (const file of sentFiles) {
    const key = toFileKey(file.source, file.filePath);

    if (sentKeys.has(key) || listedRevisions.get(key) !== file.revision) {
      throw new Error(`the export sent ${file.filePath} but does not list it at that revision`);
    }

    sentKeys.add(key);
  }

  return { header, sentFiles, files: end.files, eventCount: end.eventCount };
}
