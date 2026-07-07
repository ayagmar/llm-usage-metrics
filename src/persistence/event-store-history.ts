import type { UsageEvent } from '../domain/usage-event.js';
import { normalizeSourceId } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type { EventStore } from './event-store.js';
import { readDepartedFileEvents } from './event-store.js';

export type EventStoreHistoryDiscoveredFile = {
  source: string;
  filePath: string;
};

export type LoadHistoryEventsInput = {
  selectedSources: readonly string[];
  discoveredFiles: readonly EventStoreHistoryDiscoveredFile[];
};

export type EventStoreHistoryResult = {
  events: UsageEvent[];
  departedFileCount: number;
  servedFileCount: number;
  suppressedFileCount: number;
  servedEventCount: number;
};

type DepartedFile = {
  source: string;
  filePath: string;
  ingestedAt: number;
};

type FileContentHashMultiset = {
  counts: Map<string, number>;
  hasNullHash: boolean;
};

function toText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function toPositiveCount(value: unknown): number {
  return toNonNegativeInteger(value) ?? 0;
}

function normalizeHistorySource(source: string): string | undefined {
  return normalizeSourceId(source)?.toLowerCase();
}

function normalizeHistoryFilePath(filePath: string): string | undefined {
  const normalized = filePath.trim();
  return normalized || undefined;
}

function createTempTables(store: EventStore): void {
  store.database.exec(`
CREATE TEMP TABLE IF NOT EXISTS history_selected_sources (
  source TEXT PRIMARY KEY
);
CREATE TEMP TABLE IF NOT EXISTS history_discovered_files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  PRIMARY KEY (source, file_path)
);
DELETE FROM history_selected_sources;
DELETE FROM history_discovered_files;
`);
}

function writeTempInputs(store: EventStore, input: LoadHistoryEventsInput): Set<string> {
  const selectedSources = new Set<string>();
  const insertSelectedSource = store.database.prepare(
    'INSERT OR IGNORE INTO history_selected_sources (source) VALUES (?)',
  );
  const insertDiscoveredFile = store.database.prepare(
    ['INSERT OR IGNORE INTO history_discovered_files (source, file_path)', 'VALUES (?, ?)'].join(
      '\n',
    ),
  );

  for (const source of input.selectedSources) {
    const normalizedSource = normalizeHistorySource(source);

    if (!normalizedSource) {
      continue;
    }

    selectedSources.add(normalizedSource);
    insertSelectedSource.run(normalizedSource);
  }

  for (const discoveredFile of input.discoveredFiles) {
    const normalizedSource = normalizeHistorySource(discoveredFile.source);
    const normalizedFilePath = normalizeHistoryFilePath(discoveredFile.filePath);

    if (!normalizedSource || !normalizedFilePath || !selectedSources.has(normalizedSource)) {
      continue;
    }

    insertDiscoveredFile.run(normalizedSource, normalizedFilePath);
  }

  return selectedSources;
}

function addHashCount(target: Map<string, number>, hash: string, count: number): void {
  if (count <= 0) {
    return;
  }

  target.set(hash, (target.get(hash) ?? 0) + count);
}

function readLiveHashCounts(store: EventStore): Map<string, number> {
  const rows = store.database
    .prepare(
      [
        'SELECT events.content_hash AS content_hash, COUNT(*) AS count',
        'FROM events',
        'JOIN history_discovered_files AS discovered',
        '  ON events.source = discovered.source',
        '  AND events.file_path = discovered.file_path',
        'JOIN history_selected_sources AS selected',
        '  ON events.source = selected.source',
        'WHERE events.content_hash IS NOT NULL',
        'GROUP BY events.content_hash',
      ].join('\n'),
    )
    .all();
  const counts = new Map<string, number>();

  for (const row of rows) {
    const hash = toText(row.content_hash);

    if (!hash) {
      continue;
    }

    addHashCount(counts, hash, toPositiveCount(row.count));
  }

  return counts;
}

function compareDepartedFiles(left: DepartedFile, right: DepartedFile): number {
  if (left.ingestedAt !== right.ingestedAt) {
    return left.ingestedAt - right.ingestedAt;
  }

  if (left.filePath !== right.filePath) {
    return compareByCodePoint(left.filePath, right.filePath);
  }

  return compareByCodePoint(left.source, right.source);
}

function readDepartedFiles(store: EventStore): DepartedFile[] {
  const rows = store.database
    .prepare(
      [
        'SELECT files.source, files.file_path, files.ingested_at',
        'FROM files',
        'JOIN history_selected_sources AS selected',
        '  ON files.source = selected.source',
        'LEFT JOIN history_discovered_files AS discovered',
        '  ON files.source = discovered.source',
        '  AND files.file_path = discovered.file_path',
        'WHERE discovered.file_path IS NULL',
      ].join('\n'),
    )
    .all();
  const departedFiles: DepartedFile[] = [];

  for (const row of rows) {
    const source = toText(row.source);
    const filePath = toText(row.file_path);
    const ingestedAt = toNonNegativeInteger(row.ingested_at);

    if (!source || !filePath || ingestedAt === undefined) {
      continue;
    }

    departedFiles.push({ source, filePath, ingestedAt });
  }

  return departedFiles.sort(compareDepartedFiles);
}

function readFileContentHashMultiset(
  store: EventStore,
  file: DepartedFile,
): FileContentHashMultiset {
  const rows = store.database
    .prepare(
      [
        'SELECT content_hash, COUNT(*) AS count',
        'FROM events',
        'WHERE source = ? AND file_path = ?',
        'GROUP BY content_hash',
      ].join('\n'),
    )
    .all(file.source, file.filePath);
  const counts = new Map<string, number>();
  let hasNullHash = false;

  for (const row of rows) {
    const hash = toText(row.content_hash);

    if (!hash) {
      hasNullHash = true;
      continue;
    }

    addHashCount(counts, hash, toPositiveCount(row.count));
  }

  return { counts, hasNullHash };
}

function isSubsetOfServedData(
  fileHashCounts: FileContentHashMultiset,
  servedHashCounts: Map<string, number>,
): boolean {
  if (fileHashCounts.hasNullHash) {
    return false;
  }

  for (const [hash, count] of fileHashCounts.counts.entries()) {
    if (count > (servedHashCounts.get(hash) ?? 0)) {
      return false;
    }
  }

  return true;
}

function addFileHashCounts(
  servedHashCounts: Map<string, number>,
  fileHashCounts: FileContentHashMultiset,
): void {
  for (const [hash, count] of fileHashCounts.counts.entries()) {
    addHashCount(servedHashCounts, hash, count);
  }
}

function loadServedFileEvents(store: EventStore, files: DepartedFile[]): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const file of files) {
    events.push(...readDepartedFileEvents(store, file.source, file.filePath));
  }

  return events;
}

export function loadHistoryEvents(
  store: EventStore,
  input: LoadHistoryEventsInput,
): EventStoreHistoryResult {
  createTempTables(store);
  const selectedSources = writeTempInputs(store, input);

  if (selectedSources.size === 0) {
    return {
      events: [],
      departedFileCount: 0,
      servedFileCount: 0,
      suppressedFileCount: 0,
      servedEventCount: 0,
    };
  }

  const servedHashCounts = readLiveHashCounts(store);
  const departedFiles = readDepartedFiles(store);
  const servedFiles: DepartedFile[] = [];
  let suppressedFileCount = 0;

  for (const departedFile of departedFiles) {
    const fileHashCounts = readFileContentHashMultiset(store, departedFile);

    if (isSubsetOfServedData(fileHashCounts, servedHashCounts)) {
      suppressedFileCount += 1;
      continue;
    }

    // Partial overlap is served whole: losing genuine deleted history is worse
    // than a rare content overlap between unrelated files.
    servedFiles.push(departedFile);
    addFileHashCounts(servedHashCounts, fileHashCounts);
  }

  const events = loadServedFileEvents(store, servedFiles);

  return {
    events,
    departedFileCount: departedFiles.length,
    servedFileCount: servedFiles.length,
    suppressedFileCount,
    servedEventCount: events.length,
  };
}
