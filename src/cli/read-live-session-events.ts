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
import { getMachineCachePath, readMachineCacheSessionEvents } from '../machines/machine-cache.js';
import { getParserVersions, mergeMachineSessionEvents } from '../machines/merge-machine-events.js';
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
  /** Only these local files, by path; other machines' events are not narrowed by it. */
  filePaths?: ReadonlySet<string>;
};

export type LiveSessionEvents<K extends LiveEventKind> = {
  /**
   * The dataset's local files in its order (sources in the dataset's order, files in
   * discovery order), then the departed files history served, each file's events as read;
   * then the other machines' events, in the dataset's machine order.
   */
  events: Extract<LiveSessionEvent, { kind: K }>[];
  /** Local files read, failed ones included. */
  fileCount: number;
  /** Local files, and other machines' caches, whose read threw; their events are left out. */
  failedFilePaths: string[];
};

type FileToRead = {
  adapter: SourceAdapter;
  filePath: string;
  /** Read from the event store; otherwise from the file on disk. */
  stored: boolean;
};

const MAX_CONCURRENT_FILE_READS = 8;

export type CountedLocalFile = {
  source: string;
  filePath: string;
  /** Held by the event store as parsed; otherwise only the file on disk has its events. */
  stored: boolean;
};

/**
 * The local files whose events the dataset counts, in its order: those its usage parse
 * counted, less the ones last modified before the window, then the departed files history
 * served. None when `--machine` leaves out `local`.
 */
export function listCountedLocalFiles(dataset: UsageEventDataset): CountedLocalFile[] {
  const { machineFilter } = dataset.normalizedInputs;

  if (machineFilter && !machineFilter.has(LOCAL_MACHINE_NAME)) {
    return [];
  }

  const ledger = dataset.ledger;

  return [
    ...dataset.parsedFiles.flatMap((file) =>
      file.beforeWindow
        ? []
        : [
            {
              source: file.source,
              filePath: file.filePath,
              stored: ledger !== undefined && !file.unstored,
            },
          ],
    ),
    ...(ledger?.historyFiles ?? []).map((file) => ({
      source: file.source,
      filePath: file.filePath,
      stored: true,
    })),
  ];
}

/** The stderr note of a report built on these reads, naming what they cannot see. */
export function formatLiveEventsNote(subject: string, dataset: UsageEventDataset): string {
  const machines =
    dataset.machines === undefined
      ? ''
      : ` Other machines' ${subject.toLowerCase()} come from their last sync, once that machine runs this version too.`;

  // History serves no departed files under --no-history, or when none departed.
  const departed = dataset.ledger?.historyFiles.length ? ', departed files included' : '';

  return dataset.ledger
    ? `${subject} come from the event store (claude, codex, pi)${departed}.${machines}`
    : `${subject} are read from session files on disk (claude, codex, pi): with the event store off, files that no longer exist are not counted.${machines}`;
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

/**
 * The other machines' cached events of `kinds` from the sources in `adapters`, merged with
 * the local ones as their usage was (see `mergeMachineSessionEvents`).
 */
async function readMachineEvents(
  dataset: UsageEventDataset,
  localEvents: readonly LiveSessionEvent[],
  kinds: ReadonlySet<LiveEventKind>,
  adapters: ReadonlyMap<string, SourceAdapter>,
): Promise<{ events: LiveSessionEvent[]; failedCachePaths: string[] }> {
  const machines = dataset.machines ?? [];
  const failedCachePaths: string[] = [];

  if (machines.length === 0) {
    return { events: [], failedCachePaths };
  }
  const reads = await Promise.all(
    machines.map(async ({ name, state }) => {
      try {
        const events = await readMachineCacheSessionEvents(name, kinds);
        return {
          name,
          events: events.filter((event) => adapters.has(event.source)),
          parserVersions: state?.parserVersions,
        };
      } catch {
        failedCachePaths.push(getMachineCachePath(name));
        return { name, events: [], parserVersions: state?.parserVersions };
      }
    }),
  );
  const merged = mergeMachineSessionEvents(
    localEvents,
    reads,
    getParserVersions(dataset.adaptersToParse),
  );

  return { events: merged.flatMap((machine) => machine.events), failedCachePaths };
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
 * with usage in it. The other machines the dataset read come from their caches, without
 * the events this machine, or a machine before them, already counts; `--machine` without
 * `local` reads no local file.
 */
export async function readLiveSessionEvents<K extends LiveEventKind>(
  dataset: UsageEventDataset,
  options: ReadLiveSessionEventsOptions<K>,
): Promise<LiveSessionEvents<K>> {
  const { repoFilter, timezone } = dataset.normalizedInputs;
  const requestedKinds: ReadonlySet<LiveEventKind> = new Set(options.kinds);
  const kinds: ReadonlySet<string> = requestedKinds;
  const adapters = new Map(
    dataset.adaptersToParse
      .filter((adapter) => adapter.capabilities?.kinds?.some((kind) => kinds.has(kind)))
      .map((adapter) => [adapter.id, adapter]),
  );
  const ledger = dataset.ledger;
  const files = listCountedLocalFiles(dataset).flatMap((file): FileToRead[] => {
    const adapter = adapters.get(file.source);
    return adapter && (options.filePaths?.has(file.filePath) ?? true)
      ? [{ adapter, filePath: file.filePath, stored: file.stored }]
      : [];
  });
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
  const localEvents = reads
    .flatMap((read) => read.events)
    .filter((event): event is LiveSessionEvent => kinds.has(event.kind));
  const machineEvents = await readMachineEvents(dataset, localEvents, requestedKinds, adapters);
  const failedFilePaths = [
    ...files.filter((_, index) => reads[index].failed).map((file) => file.filePath),
    ...machineEvents.failedCachePaths,
  ];
  const events = [...localEvents, ...machineEvents.events].filter(
    (event): event is Extract<LiveSessionEvent, { kind: K }> => {
      if (!kinds.has(event.kind) || !isInWindow(event.timestamp)) {
        return false;
      }

      const sessionKey = getEventSessionKey(event);
      return (
        (repoSessions?.has(sessionKey) ?? true) && (options.sessionKeys?.has(sessionKey) ?? true)
      );
    },
  );

  return { events, fileCount: files.length, failedFilePaths };
}
