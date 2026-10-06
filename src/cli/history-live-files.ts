import { stat } from 'node:fs/promises';

import type { EventStore } from '../persistence/event-store-database.js';
import {
  readUndiscoveredStoredFiles,
  type LoadHistoryEventsInput,
} from '../persistence/event-store-history.js';

type StatFile = (filePath: string) => Promise<unknown>;

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function isStillOnDisk(filePath: string, statFile: StatFile): Promise<boolean> {
  try {
    await statFile(filePath);
    return true;
  } catch (error) {
    // Only a missing path proves a file departed; unreadable files are kept as live.
    return !isMissingPathError(error);
  }
}

/**
 * History and prune treat stored files the run did not discover as departed. A file
 * that still exists on disk has not departed (discovery was narrowed, e.g. by
 * `--source-dir`), so it is added to the live set: its stored events are neither
 * served as history nor offered for pruning.
 */
export async function addStoredFilesStillOnDisk(
  store: EventStore,
  input: LoadHistoryEventsInput,
  statFile: StatFile = stat,
): Promise<LoadHistoryEventsInput> {
  const undiscoveredFiles = readUndiscoveredStoredFiles(store, input);
  const presence = await Promise.all(
    undiscoveredFiles.map((file) => isStillOnDisk(file.filePath, statFile)),
  );
  const filesStillOnDisk = undiscoveredFiles.filter((_, index) => presence[index]);

  if (filesStillOnDisk.length === 0) {
    return input;
  }

  return { ...input, discoveredFiles: [...input.discoveredFiles, ...filesStillOnDisk] };
}
