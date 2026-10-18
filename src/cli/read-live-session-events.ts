import {
  collect,
  getEventSessionKey,
  readEvents,
  type MessageEvent,
  type SourceAdapter,
  type ToolCallEvent,
} from '@ayagmar/agent-sessions';

import { LOCAL_MACHINE_NAME } from '../domain/usage-event.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';
import { readStoredSessionEvents } from '../persistence/event-store.js';
import type { UsageEventDataset } from './build-usage-event-dataset.js';
import { mapWithConcurrency } from './history-live-files.js';
import { createTimestampWindowFilter } from './parse/usage-event-filters.js';

/** The non-usage events read for a report: from the event store, or live without it. */
export type LiveSessionEvent = ToolCallEvent | MessageEvent;

export type LiveEventKind = LiveSessionEvent['kind'];

export type ReadLiveSessionEventsOptions<K extends LiveEventKind> = {
  kinds: readonly K[];
  /** Only these sessions, as `getEventSessionKey` keys them. */
  sessionKeys?: ReadonlySet<string>;
  /** Only these files, by path. */
  filePaths?: ReadonlySet<string>;
};

export type LiveSessionEvents<K extends LiveEventKind> = {
  /**
   * The dataset's local files in its order (sources in the dataset's order, files in
   * discovery order), then the departed files history served; each file's events as read.
   */
  events: Extract<LiveSessionEvent, { kind: K }>[];
  /** Files read, failed ones included. */
  fileCount: number;
  /** Files whose read threw; their events are left out. */
  failedFilePaths: string[];
};

type FileToRead = {
  adapter: SourceAdapter;
  filePath: string;
  /** Read from the event store; otherwise from the file on disk. */
  stored: boolean;
};

const MAX_CONCURRENT_FILE_READS = 8;

/** The stderr note of a report built on these reads, naming what they cannot see. */
export function formatLiveEventsNote(subject: string, dataset: UsageEventDataset): string {
  return dataset.ledger
    ? `${subject} come from the event store (claude, codex, pi), departed files included; other machines are not counted.`
    : `${subject} are read from session files on disk (claude, codex, pi): with the event store off, files that no longer exist and other machines are not counted.`;
}

/** The warning for the live reads that threw, or none. */
export function formatFailedLiveReads(
  subject: string,
  failedFilePaths: readonly string[],
): string[] {
  return failedFilePaths.length === 0
    ? []
    : [
        `${subject} left out of ${pluralize(failedFilePaths.length, 'file')} that could not be read`,
      ];
}

async function readStoredFiles(
  storePath: string,
  files: readonly FileToRead[],
  kinds: ReadonlySet<LiveEventKind>,
): Promise<{ events: LiveSessionEvent[]; failed?: true }[]> {
  try {
    const events = await readStoredSessionEvents(
      storePath,
      files.map((file) => ({ source: file.adapter.id, filePath: file.filePath })),
      kinds,
    );
    return events.map((fileEvents) => ({ events: fileEvents }));
  } catch {
    return files.map(() => ({ events: [], failed: true }));
  }
}

/**
 * Reads `kinds` events of the dataset's local files: those its usage parse counted (so the
 * same discovery, source selection and since-mtime skip, which here also drops the files
 * parsed only for the event store), from the sources that declare one of the kinds. With the
 * event store, they come from it, as do those of the departed files history served; a file
 * parsed but not stored, and every file without the store, is read from disk. Events are
 * kept inside the dataset's date window and, when `--repo` narrowed it, only for sessions
 * with usage in it. Other machines have no such events, and `--machine` without `local`
 * reads nothing.
 */
export async function readLiveSessionEvents<K extends LiveEventKind>(
  dataset: UsageEventDataset,
  options: ReadLiveSessionEventsOptions<K>,
): Promise<LiveSessionEvents<K>> {
  const { machineFilter, repoFilter, timezone } = dataset.normalizedInputs;

  if (machineFilter && !machineFilter.has(LOCAL_MACHINE_NAME)) {
    return { events: [], fileCount: 0, failedFilePaths: [] };
  }

  const requestedKinds: ReadonlySet<LiveEventKind> = new Set(options.kinds);
  const kinds: ReadonlySet<string> = requestedKinds;
  const adapters = new Map(
    dataset.adaptersToParse
      .filter((adapter) => adapter.capabilities?.kinds?.some((kind) => kinds.has(kind)))
      .map((adapter) => [adapter.id, adapter]),
  );
  const ledger = dataset.ledger;
  const toFileToRead = (
    file: { source: string; filePath: string },
    stored: boolean,
  ): FileToRead[] => {
    const adapter = adapters.get(file.source);
    return adapter && (options.filePaths?.has(file.filePath) ?? true)
      ? [{ adapter, filePath: file.filePath, stored }]
      : [];
  };
  const files = [
    ...dataset.parsedFiles.flatMap((file) =>
      file.beforeWindow ? [] : toFileToRead(file, ledger !== undefined && !file.unstored),
    ),
    ...(ledger?.historyFiles ?? []).flatMap((file) => toFileToRead(file, true)),
  ];
  const repoSessions =
    repoFilter === undefined
      ? undefined
      : new Set(dataset.filteredEvents.map((event) => getEventSessionKey(event)));
  const isInWindow = createTimestampWindowFilter({
    timezone,
    since: dataset.options.since,
    until: dataset.options.until,
  });

  const storedFiles = files.filter((file) => file.stored);
  const storedReads =
    ledger && storedFiles.length > 0
      ? await readStoredFiles(ledger.path, storedFiles, requestedKinds)
      : [];
  const diskReads = await mapWithConcurrency(
    files.filter((file) => !file.stored),
    MAX_CONCURRENT_FILE_READS,
    async (file) => {
      try {
        return {
          events: await collect(readEvents(file.adapter, file.filePath, { kinds: options.kinds })),
        };
      } catch {
        return { events: [], failed: true };
      }
    },
  );
  let storedIndex = 0;
  let diskIndex = 0;
  const reads = files.map((file) =>
    file.stored ? storedReads[storedIndex++] : diskReads[diskIndex++],
  );
  const failedFilePaths = files
    .filter((_, index) => reads[index].failed)
    .map((file) => file.filePath);
  const events = reads
    .flatMap((read) => read.events)
    .filter((event): event is Extract<LiveSessionEvent, { kind: K }> => {
      if (!kinds.has(event.kind) || !isInWindow(event.timestamp)) {
        return false;
      }

      const sessionKey = getEventSessionKey(event);
      return (
        (repoSessions?.has(sessionKey) ?? true) && (options.sessionKeys?.has(sessionKey) ?? true)
      );
    });

  return { events, fileCount: files.length, failedFilePaths };
}
