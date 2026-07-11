import type { UsageEvent } from '../domain/usage-event.js';
import { normalizeSourceId } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import type { EventStore } from './event-store.js';
import { normalizeStoredEvent } from './event-store.js';

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
  eventCount: number;
  newestTimestamp?: string;
};

export type ClassifiedDepartedFile = {
  source: string;
  filePath: string;
  eventCount: number;
  newestTimestamp?: string;
  suppressed: boolean;
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
CREATE TEMP TABLE IF NOT EXISTS history_departed_files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  PRIMARY KEY (source, file_path)
);
CREATE TEMP TABLE IF NOT EXISTS history_served_files (
  source TEXT NOT NULL,
  file_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (source, file_path)
);
DELETE FROM history_selected_sources;
DELETE FROM history_discovered_files;
DELETE FROM history_departed_files;
DELETE FROM history_served_files;
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
        'SELECT files.source, files.file_path, files.ingested_at,',
        '  COUNT(events.id) AS event_count, MAX(events.timestamp) AS newest_timestamp',
        'FROM files',
        'JOIN history_selected_sources AS selected',
        '  ON files.source = selected.source',
        'LEFT JOIN history_discovered_files AS discovered',
        '  ON files.source = discovered.source',
        '  AND files.file_path = discovered.file_path',
        'LEFT JOIN events',
        '  ON files.source = events.source',
        '  AND files.file_path = events.file_path',
        'WHERE discovered.file_path IS NULL',
        'GROUP BY files.source, files.file_path, files.ingested_at',
      ].join('\n'),
    )
    .all();
  const departedFiles: DepartedFile[] = [];

  for (const row of rows) {
    const source = toText(row.source);
    const filePath = toText(row.file_path);
    const ingestedAt = toNonNegativeInteger(row.ingested_at);
    const eventCount = toNonNegativeInteger(row.event_count);
    const newestTimestamp = toText(row.newest_timestamp);

    if (!source || !filePath || ingestedAt === undefined || eventCount === undefined) {
      continue;
    }

    departedFiles.push({ source, filePath, ingestedAt, eventCount, newestTimestamp });
  }

  return departedFiles.sort(compareDepartedFiles);
}

function fileKey(source: string, filePath: string): string {
  return JSON.stringify([source, filePath]);
}

// One grouped read of every departed file's content-hash multiset. Populates
// history_departed_files with the same anti-join readDepartedFiles uses (files
// present for a selected source but not discovered live), then groups events by
// (source, file_path, content_hash). A NULL content_hash group marks that file
// unsuppressible; a departed file with zero event rows produces no row here and
// is handed an empty multiset by the caller.
function readDepartedHashMultisets(store: EventStore): Map<string, FileContentHashMultiset> {
  store.database
    .prepare(
      [
        'INSERT INTO history_departed_files (source, file_path)',
        'SELECT files.source, files.file_path',
        'FROM files',
        'JOIN history_selected_sources AS selected',
        '  ON files.source = selected.source',
        'LEFT JOIN history_discovered_files AS discovered',
        '  ON files.source = discovered.source',
        '  AND files.file_path = discovered.file_path',
        'WHERE discovered.file_path IS NULL',
      ].join('\n'),
    )
    .run();

  const rows = store.database
    .prepare(
      [
        'SELECT events.source AS source, events.file_path AS file_path,',
        '  events.content_hash AS content_hash, COUNT(*) AS count',
        'FROM events',
        'JOIN history_departed_files AS departed',
        '  ON events.source = departed.source',
        '  AND events.file_path = departed.file_path',
        'GROUP BY events.source, events.file_path, events.content_hash',
      ].join('\n'),
    )
    .all();
  const multisets = new Map<string, FileContentHashMultiset>();

  for (const row of rows) {
    const source = toText(row.source);
    const filePath = toText(row.file_path);

    if (!source || !filePath) {
      continue;
    }

    const key = fileKey(source, filePath);
    let multiset = multisets.get(key);

    if (!multiset) {
      multiset = { counts: new Map(), hasNullHash: false };
      multisets.set(key, multiset);
    }

    const hash = toText(row.content_hash);

    if (!hash) {
      multiset.hasNullHash = true;
      continue;
    }

    addHashCount(multiset.counts, hash, toPositiveCount(row.count));
  }

  return multisets;
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

// One joined read of every served file's events, ordered by the classification
// order (encoded as ordinal) then event_index — identical to concatenating each
// served file's rows in classified order. An un-normalizable row is skipped, not
// invalidated: a departed file has no source data left to re-parse.
function loadServedEvents(
  store: EventStore,
  servedFiles: readonly ClassifiedDepartedFile[],
): UsageEvent[] {
  if (servedFiles.length === 0) {
    return [];
  }

  // Chunk the multi-row INSERT so it never approaches SQLite's bound-parameter
  // limit (SQLITE_MAX_VARIABLE_NUMBER, 32766 on node:sqlite): 500 files * 3
  // params = 1500 stays well under any build. Ordinal is the global
  // classification index, so ordering is preserved across chunk boundaries.
  const INSERT_CHUNK_FILES = 500;

  for (let start = 0; start < servedFiles.length; start += INSERT_CHUNK_FILES) {
    const chunk = servedFiles.slice(start, start + INSERT_CHUNK_FILES);
    const placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
    const params: (string | number)[] = [];

    chunk.forEach((file, index) => {
      params.push(file.source, file.filePath, start + index);
    });

    store.database
      .prepare(
        `INSERT INTO history_served_files (source, file_path, ordinal) VALUES ${placeholders}`,
      )
      .run(...params);
  }

  const rows = store.database
    .prepare(
      [
        'SELECT events.source, events.session_id, events.timestamp, events.model,',
        '  events.provider, events.repo_root, events.input_tokens, events.output_tokens,',
        '  events.reasoning_tokens, events.cache_read_tokens, events.cache_write_tokens,',
        '  events.total_tokens, events.cost_usd, events.cost_mode',
        'FROM events',
        'JOIN history_served_files AS served',
        '  ON events.source = served.source',
        '  AND events.file_path = served.file_path',
        'ORDER BY served.ordinal ASC, events.event_index ASC',
      ].join('\n'),
    )
    .all();
  const events: UsageEvent[] = [];

  for (const row of rows) {
    const event = normalizeStoredEvent(row);

    if (!event) {
      continue;
    }

    events.push(event);
  }

  return events;
}

export function classifyDepartedFiles(
  store: EventStore,
  input: LoadHistoryEventsInput,
): ClassifiedDepartedFile[] {
  createTempTables(store);
  const selectedSources = writeTempInputs(store, input);

  if (selectedSources.size === 0) {
    return [];
  }

  const servedHashCounts = readLiveHashCounts(store);
  const departedFiles = readDepartedFiles(store);
  const departedHashMultisets = readDepartedHashMultisets(store);
  const classifiedFiles: ClassifiedDepartedFile[] = [];

  for (const departedFile of departedFiles) {
    // A departed file with zero event rows has no grouped multiset, so it gets
    // an empty one — the subset check then passes vacuously and suppresses it.
    const fileHashCounts = departedHashMultisets.get(
      fileKey(departedFile.source, departedFile.filePath),
    ) ?? { counts: new Map<string, number>(), hasNullHash: false };
    const suppressed = isSubsetOfServedData(fileHashCounts, servedHashCounts);

    classifiedFiles.push({
      source: departedFile.source,
      filePath: departedFile.filePath,
      eventCount: departedFile.eventCount,
      newestTimestamp: departedFile.newestTimestamp,
      suppressed,
    });

    if (suppressed) {
      continue;
    }

    // Partial overlap is served whole: losing genuine deleted history is worse
    // than a rare content overlap between unrelated files.
    addFileHashCounts(servedHashCounts, fileHashCounts);
  }

  return classifiedFiles;
}

export function loadHistoryEvents(
  store: EventStore,
  input: LoadHistoryEventsInput,
): EventStoreHistoryResult {
  const departedFiles = classifyDepartedFiles(store, input);
  const servedFiles = departedFiles.filter((file) => !file.suppressed);
  const events = loadServedEvents(store, servedFiles);
  const suppressedFileCount = departedFiles.length - servedFiles.length;

  return {
    events,
    departedFileCount: departedFiles.length,
    servedFileCount: servedFiles.length,
    suppressedFileCount,
    servedEventCount: events.length,
  };
}
