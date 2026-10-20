import { getEventSessionKey, type ToolCallEvent } from '@ayagmar/agent-sessions';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

import { readStoredFileSessionIds } from '../persistence/event-store.js';
import type { SessionRow } from '../session/session-row.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import type { UsageEventDataset } from './build-usage-event-dataset.js';
import { listCountedLocalFiles } from './read-live-session-events.js';

/** The sources whose sessions get tool call counts: those whose files log tool calls. */
export function getToolCallSources(dataset: UsageEventDataset): ReadonlySet<string> {
  return new Set(
    dataset.adaptersToParse
      .filter((adapter) => adapter.capabilities?.kinds?.includes('tool_call'))
      .map((adapter) => adapter.id),
  );
}

/** The local files of the sources of `rows` that the dataset counts, by path. */
export function listSessionSourceFilePaths(
  dataset: UsageEventDataset,
  rows: readonly SessionRow[],
): Set<string> {
  const sources = new Set(rows.map((row) => row.source));

  return new Set(
    listCountedLocalFiles(dataset)
      .filter((file) => sources.has(file.source))
      .map((file) => file.filePath),
  );
}

/**
 * Each session's local files, keyed by `getEventSessionKey`: the stored files this run
 * counts whose usage events carry the session id, in code-point order. Empty without the
 * event store; a store that cannot be read gives a warning instead.
 */
async function readSessionFilePaths(
  dataset: UsageEventDataset,
  rows: readonly SessionRow[],
): Promise<{ filePaths: Map<string, string[]>; warnings: string[] }> {
  const filePaths = new Map<string, string[]>();

  if (!dataset.ledger || rows.length === 0) {
    return { filePaths, warnings: [] };
  }

  const sessionKeys = new Set(rows.map((row) => getEventSessionKey(row)));
  const sources = new Set(rows.map((row) => row.source));
  const files = listCountedLocalFiles(dataset).filter(
    (file) => file.stored && sources.has(file.source),
  );
  let sessionIdsByFile: string[][];

  try {
    sessionIdsByFile = await readStoredFileSessionIds(dataset.ledger.path, files);
  } catch (error) {
    return {
      filePaths,
      warnings: [
        `Session files left out: the event store could not be read: ${getErrorReason(error)}`,
      ],
    };
  }

  files.forEach((file, index) => {
    for (const sessionId of sessionIdsByFile[index]) {
      const key = getEventSessionKey({ source: file.source, sessionId });

      if (sessionKeys.has(key)) {
        filePaths.set(key, [...(filePaths.get(key) ?? []), file.filePath]);
      }
    }
  });

  for (const paths of filePaths.values()) {
    paths.sort(compareByCodePoint);
  }

  return { filePaths, warnings: [] };
}

/** The tool calls read for the rows, and the reads that failed (see `readLiveSessionEvents`). */
export type SessionToolCalls = {
  calls: readonly ToolCallEvent[];
  failedFilePaths: readonly string[];
};

/**
 * The sources whose tool call counts a failed read leaves unknown: a local file's source,
 * or every source for another machine's cache, whose path names no source.
 */
function listUnreadSources(
  dataset: UsageEventDataset,
  failedFilePaths: readonly string[],
  toolCallSources: ReadonlySet<string>,
): Set<string> {
  const localSources = new Map(
    listCountedLocalFiles(dataset).map((file) => [file.filePath, file.source]),
  );

  return new Set(
    failedFilePaths.flatMap((filePath) => {
      const source = localSources.get(filePath);
      return source === undefined ? [...toolCallSources] : [source];
    }),
  );
}

/**
 * The rows with what --json adds: their local files and, for sessions of `toolCallSources`,
 * their counts of the calls (deduplicated as `tools` deduplicates them). A source with a
 * failed read gets no counts, since they would read as fewer calls than were made.
 */
export async function addSessionDetails(
  dataset: UsageEventDataset,
  rows: readonly SessionRow[],
  toolCalls: SessionToolCalls,
  toolCallSources: ReadonlySet<string>,
): Promise<{ rows: SessionRow[]; warnings: string[] }> {
  const { filePaths, warnings } = await readSessionFilePaths(dataset, rows);
  const unreadSources = listUnreadSources(dataset, toolCalls.failedFilePaths, toolCallSources);
  const toolCounts = new Map<string, { toolCalls: number; toolErrors: number }>();

  for (const call of toolCalls.calls) {
    const key = getEventSessionKey(call);
    const counts = toolCounts.get(key) ?? { toolCalls: 0, toolErrors: 0 };
    counts.toolCalls += 1;
    counts.toolErrors += call.status === 'error' ? 1 : 0;
    toolCounts.set(key, counts);
  }

  return {
    rows: rows.map((row) => {
      const key = getEventSessionKey(row);
      const paths = filePaths.get(key);
      const countsKnown = toolCallSources.has(row.source) && !unreadSources.has(row.source);

      return {
        ...row,
        ...(paths && { filePaths: paths }),
        ...(countsKnown && (toolCounts.get(key) ?? { toolCalls: 0, toolErrors: 0 })),
      };
    }),
    warnings,
  };
}
