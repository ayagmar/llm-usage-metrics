import type { MachineConfig } from '../config/user-config.js';
import { closeEventStore } from '../persistence/event-store.js';
import {
  claimMachineSync,
  isMachineSyncDue,
  openMachineCache,
  readMachineSyncStateIfCached,
} from './machine-cache.js';
import type { SpawnSsh } from './machine-ssh.js';
import { syncMachine, type MachineSyncOutcome } from './sync-machine.js';

/** Reports refresh a machine whose last sync, or attempt, is at least this old. */
export const MACHINE_REFRESH_INTERVAL_MS = 10 * 60_000;
/** A report waits this long for a machine before it uses the cached usage. */
export const MACHINE_REFRESH_TIMEOUT_MS = 30_000;

async function claimDueSync(name: string, now: number): Promise<boolean> {
  // A cheap read-only look first: a fresh cache takes no write lock.
  try {
    if (
      !isMachineSyncDue(await readMachineSyncStateIfCached(name), now, MACHINE_REFRESH_INTERVAL_MS)
    ) {
      return false;
    }
  } catch {
    // An unreadable state: let the claim, or the sync, report what is wrong.
  }

  try {
    const cache = await openMachineCache(name);

    try {
      return claimMachineSync(cache, now, MACHINE_REFRESH_INTERVAL_MS);
    } finally {
      closeEventStore(cache);
    }
  } catch {
    // Busy (another run is syncing it) or broken: the report uses what is cached.
    return false;
  }
}

/**
 * Syncs the enabled machines whose cache is due, in parallel and within a timeout, for a
 * report about to read them. Only syncs that ran return an outcome.
 */
export async function refreshDueMachines(
  machines: readonly { name: string; machine: MachineConfig }[],
  options: { now?: () => number; spawnSsh?: SpawnSsh } = {},
): Promise<MachineSyncOutcome[]> {
  const now = options.now ?? Date.now;
  const outcomes = await Promise.all(
    machines
      .filter(({ machine }) => machine.enabled !== false)
      .map(async ({ name, machine }) => {
        if (!(await claimDueSync(name, now()))) {
          return undefined;
        }

        return syncMachine(name, machine, {
          spawnSsh: options.spawnSsh,
          now,
          timeoutMs: MACHINE_REFRESH_TIMEOUT_MS,
        });
      }),
  );

  return outcomes.filter((outcome) => outcome !== undefined);
}
