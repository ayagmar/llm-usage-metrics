import { stat } from 'node:fs/promises';

import type { EventStore } from '../persistence/event-store-database.js';
import {
  readUndiscoveredStoredFiles,
  type LoadHistoryEventsInput,
} from '../persistence/event-store-history.js';
import { hasErrorCode } from '../utils/error-code.js';

type StatFile = (filePath: string) => Promise<unknown>;

type DiskPresence = 'present' | 'missing' | 'unknown';

/**
 * How a stored file whose presence cannot be checked (e.g. EACCES) is treated. History
 * serves it as departed so usage is never hidden; prune keeps it live so nothing is
 * deleted without proof that the file is gone.
 */
export type UnverifiableStoredFilePolicy = 'treat-as-departed' | 'treat-as-live';

const MAX_CONCURRENT_STATS = 32;

async function checkDiskPresence(filePath: string, statFile: StatFile): Promise<DiskPresence> {
  try {
    await statFile(filePath);
    return 'present';
  } catch (error) {
    return hasErrorCode(error, 'ENOENT', 'ENOTDIR') ? 'missing' : 'unknown';
  }
}

export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  mapInput: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      outputs[index] = await mapInput(inputs[index]);
    }
  });

  await Promise.all(workers);
  return outputs;
}

/**
 * History and prune treat stored files the run did not discover as departed. A file
 * that still exists on disk has not departed (discovery was narrowed, e.g. by
 * `--source-dir`), so it is passed as a present file: its stored events are neither
 * served as history nor offered for pruning.
 */
export async function addStoredFilesStillOnDisk(
  store: EventStore,
  input: LoadHistoryEventsInput,
  options: { unverifiable: UnverifiableStoredFilePolicy; statFile?: StatFile },
): Promise<LoadHistoryEventsInput> {
  const statFile = options.statFile ?? stat;
  const undiscoveredFiles = readUndiscoveredStoredFiles(store, input);
  const presence = await mapWithConcurrency(undiscoveredFiles, MAX_CONCURRENT_STATS, (file) =>
    checkDiskPresence(file.filePath, statFile),
  );
  const presentFiles = undiscoveredFiles.filter(
    (_, index) =>
      presence[index] === 'present' ||
      (presence[index] === 'unknown' && options.unverifiable === 'treat-as-live'),
  );

  if (presentFiles.length === 0) {
    return input;
  }

  return { ...input, presentFiles: [...(input.presentFiles ?? []), ...presentFiles] };
}
