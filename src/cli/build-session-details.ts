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

/**
 * The rows with what --json adds: their local files and, for sessions of `toolCallSources`,
 * their counts of `toolCalls` (deduplicated as `tools` deduplicates them).
 */
export async function addSessionDetails(
  dataset: UsageEventDataset,
  rows: readonly SessionRow[],
  toolCalls: readonly ToolCallEvent[],
  toolCallSources: ReadonlySet<string>,
): Promise<{ rows: SessionRow[]; warnings: string[] }> {
  const { filePaths, warnings } = await readSessionFilePaths(dataset, rows);
  const toolCounts = new Map<string, { toolCalls: number; toolErrors: number }>();

  for (const call of toolCalls) {
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

      return {
        ...row,
        ...(paths && { filePaths: paths }),
        ...(toolCallSources.has(row.source) &&
          (toolCounts.get(key) ?? { toolCalls: 0, toolErrors: 0 })),
      };
    }),
    warnings,
  };
}
