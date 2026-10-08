import type { MachineConfig } from '../config/user-config.js';
import { closeEventStore, type EventStore } from '../persistence/event-store.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import {
  applyMachineExport,
  getMachineCachePath,
  openMachineCache,
  readCachedFiles,
  readMachineSyncState,
  recordMachineSyncFailure,
  type MachineSyncResult,
  type MachineSyncState,
} from './machine-cache.js';
import { fetchMachineExport, type SpawnSsh } from './machine-ssh.js';

export type MachineSyncOutcome =
  | {
      name: string;
      ok: true;
      result: MachineSyncResult;
      remoteWarnings: string[];
      state: MachineSyncState;
    }
  | { name: string; ok: false; error: string; state: MachineSyncState };

export type SyncMachineOptions = {
  /** Ask for every file again instead of only the changed ones. */
  full?: boolean;
  timeoutMs?: number;
  spawnSsh?: SpawnSsh;
  now?: () => number;
};

/**
 * Syncs one machine's cache; it never throws, so one machine cannot stop the others. A
 * failed sync leaves the cached usage as it was and records why, so reports can keep
 * using it and say how stale it is.
 */
export async function syncMachine(
  name: string,
  machine: MachineConfig,
  options: SyncMachineOptions = {},
): Promise<MachineSyncOutcome> {
  const now = options.now ?? Date.now;
  let cache: EventStore;

  try {
    cache = await openMachineCache(name);
  } catch (error) {
    return {
      name,
      ok: false,
      error: `cannot open its cache at ${getMachineCachePath(name)}: ${getErrorReason(error)}`,
      state: {},
    };
  }

  try {
    const { bundle, remoteWarnings } = await fetchMachineExport(
      machine,
      options.full === true ? [] : readCachedFiles(cache),
      { spawnSsh: options.spawnSsh, timeoutMs: options.timeoutMs },
    );
    const result = applyMachineExport(cache, bundle, now());

    return { name, ok: true, result, remoteWarnings, state: readMachineSyncState(cache) };
  } catch (error) {
    const reason = getErrorReason(error);

    let state: MachineSyncState = {};

    // A busy or broken cache cannot record the failure; the outcome still reports it.
    try {
      recordMachineSyncFailure(cache, reason, now());
      state = readMachineSyncState(cache);
    } catch {
      // Nothing more to report than the failure itself.
    }

    return { name, ok: false, error: reason, state };
  } finally {
    closeEventStore(cache);
  }
}
