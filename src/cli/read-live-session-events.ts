import {
  collect,
  getEventSessionKey,
  readEvents,
  type MessageEvent,
  type ToolCallEvent,
} from '@ayagmar/agent-sessions';

import { LOCAL_MACHINE_NAME } from '../domain/usage-event.js';
import { pluralize } from '../render/format-number.js';
import type { UsageEventDataset } from './build-usage-event-dataset.js';
import { mapWithConcurrency } from './history-live-files.js';
import { createTimestampWindowFilter } from './parse/usage-event-filters.js';

/** The non-usage events read live: the event store holds usage only. */
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
  /** Sources in the dataset's order, files in discovery order, each file's events as read. */
  events: Extract<LiveSessionEvent, { kind: K }>[];
  /** Files read, failed ones included. */
  fileCount: number;
  /** Files whose read threw; their events are left out. */
  failedFilePaths: string[];
};

const MAX_CONCURRENT_FILE_READS = 8;

/** The stderr note of a report built on live reads, naming what they cannot see. */
export function formatLiveEventsNote(subject: string): string {
  return `${subject} are read from session files on disk (claude, codex, pi): files that no longer exist and other machines are not counted.`;
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
 * Reads `kinds` events live from the dataset's local files: the files its usage parse counted
 * (so the same discovery, source selection and since-mtime skip), from the sources that
 * declare one of the kinds. Events are kept inside the dataset's date window and, when
 * `--repo` narrowed it, only for sessions with usage in it. Files that left the disk and
 * other machines have no such events, and `--machine` without `local` reads nothing.
 */
export async function readLiveSessionEvents<K extends LiveEventKind>(
  dataset: UsageEventDataset,
  options: ReadLiveSessionEventsOptions<K>,
): Promise<LiveSessionEvents<K>> {
  const { machineFilter, repoFilter, timezone } = dataset.normalizedInputs;

  if (machineFilter && !machineFilter.has(LOCAL_MACHINE_NAME)) {
    return { events: [], fileCount: 0, failedFilePaths: [] };
  }

  const kinds: ReadonlySet<string> = new Set(options.kinds);
  const adapters = new Map(
    dataset.adaptersToParse
      .filter((adapter) => adapter.capabilities?.kinds?.some((kind) => kinds.has(kind)))
      .map((adapter) => [adapter.id, adapter]),
  );
  const files = dataset.parsedFiles.flatMap((file) => {
    const adapter = adapters.get(file.source);
    return adapter && (options.filePaths?.has(file.filePath) ?? true)
      ? [{ adapter, filePath: file.filePath }]
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

  const reads = await mapWithConcurrency(files, MAX_CONCURRENT_FILE_READS, async (file) => {
    try {
      return {
        events: await collect(readEvents(file.adapter, file.filePath, { kinds: options.kinds })),
      };
    } catch {
      return { events: [], failed: true };
    }
  });
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
