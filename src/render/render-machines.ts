import type { MachineConfig } from '../config/user-config.js';
import type { MachineSyncState } from '../machines/machine-cache.js';
import type { MachineUsageSummary } from '../machines/load-machine-usage.js';
import { MACHINE_EXPORT_TIMEOUT_MARK } from '../machines/machine-ssh.js';
import type { MachineSyncOutcome } from '../machines/sync-machine.js';

const integerFormat = new Intl.NumberFormat('en-US');

export function formatAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 48) {
    return `${hours} h ago`;
  }

  return `${Math.floor(hours / 24)} days ago`;
}

function formatCachedTotals(fileCount: number, eventCount: number): string {
  return `${integerFormat.format(fileCount)} file(s), ${integerFormat.format(eventCount)} event(s)`;
}

function formatRemoteVersion(state: MachineSyncState): string {
  if (!state.cliVersion) {
    return '';
  }

  return state.hostname
    ? ` from ${state.hostname} (llm-usage-metrics ${state.cliVersion})`
    : ` (llm-usage-metrics ${state.cliVersion})`;
}

/** One line per machine, then any warnings its export printed. */
export function renderSyncOutcome(outcome: MachineSyncOutcome, now: number): string[] {
  if (outcome.ok) {
    const { result } = outcome;
    const changes =
      result.receivedFileCount === 0 && result.removedFileCount === 0
        ? 'up to date'
        : `${integerFormat.format(result.receivedFileCount)} file(s) updated, ${integerFormat.format(result.removedFileCount)} removed`;

    return [
      `✓ ${outcome.name}: ${changes}; ${formatCachedTotals(result.fileCount, result.eventCount)} cached${formatRemoteVersion(outcome.state)}`,
      ...outcome.remoteWarnings.map((warning) => `  ${outcome.name} warned: ${warning}`),
    ];
  }

  const cacheNote =
    outcome.state.syncedAt === undefined
      ? 'nothing cached yet'
      : `reports keep its usage from ${formatAge(now - outcome.state.syncedAt)}`;

  return [`✗ ${outcome.name}: ${outcome.error} (${cacheNote})`];
}

export type MachineListEntry = {
  name: string;
  machine: MachineConfig;
  state?: MachineSyncState;
  fileCount: number;
  eventCount: number;
};

export function describeMachineStatus(entry: MachineListEntry, now: number): string {
  const { state } = entry;

  if (entry.machine.enabled === false) {
    return 'disabled (cached usage stays in reports)';
  }

  if (state?.syncedAt === undefined) {
    return state?.lastError ? `never synced: ${state.lastError}` : 'never synced';
  }

  const synced = `synced ${formatAge(now - state.syncedAt)}, ${formatCachedTotals(entry.fileCount, entry.eventCount)}`;

  if (state.lastError && (state.attemptedAt ?? 0) >= state.syncedAt) {
    return `${synced}; last attempt failed ${formatAge(now - (state.attemptedAt ?? 0))}: ${state.lastError}`;
  }

  return synced;
}

export function renderMachineList(entries: readonly MachineListEntry[], now: number): string[] {
  if (entries.length === 0) {
    return ['No machines configured.', 'Add one with: llm-usage machine add <name> <user@host>'];
  }

  return entries.map(
    (entry) => `${entry.name}  ${entry.machine.ssh}  ${describeMachineStatus(entry, now)}`,
  );
}

function describeIncludedMachine(
  machine: MachineUsageSummary,
  now: number,
  localVersion: string,
): string {
  const { state } = machine;

  if (state?.syncedAt === undefined) {
    return `${machine.name} (never synced; run llm-usage sync ${machine.name})`;
  }

  const details = [`synced ${formatAge(now - state.syncedAt)}`];

  if (state.lastError !== undefined && (state.attemptedAt ?? 0) >= state.syncedAt) {
    details.push('last sync failed');
  }

  // Parsers change between versions, so a session copied to both machines may not match.
  if (state.cliVersion && state.cliVersion !== localVersion) {
    details.push(
      `llm-usage-metrics ${state.cliVersion} there; shared sessions may count twice until both run the same version`,
    );
  }

  return `${machine.name} (${details.join(', ')})`;
}

/** The stderr note of a report that counts other machines' usage. */
export function formatMachinesNote(
  machines: readonly MachineUsageSummary[],
  now: number,
  localVersion: string,
): string {
  const duplicateCount = machines.reduce((sum, machine) => sum + machine.duplicateCount, 0);
  const duplicates =
    duplicateCount > 0
      ? `; left out ${integerFormat.format(duplicateCount)} event(s) already counted`
      : '';

  return `Machines: ${machines.map((machine) => describeIncludedMachine(machine, now, localVersion)).join(', ')}${duplicates}.`;
}

/** Past this age a machine's cached usage is worth a warning when it cannot refresh. */
const STALE_CACHE_MS = 24 * 60 * 60_000;

/**
 * Describes a refresh a report could not do. A machine that is off is normal, so a
 * recent cache gets a note; an old or empty one a warning.
 */
export function formatRefreshFailure(
  outcome: MachineSyncOutcome,
  now: number,
): { text: string; stale: boolean } | undefined {
  if (outcome.ok) {
    return undefined;
  }

  const { syncedAt } = outcome.state;

  if (syncedAt === undefined) {
    return {
      text: `Could not sync ${outcome.name} (${outcome.error}); it has no usage cached yet.`,
      stale: true,
    };
  }

  // A remote that needs longer than a report waits can still be synced by hand.
  const hint = outcome.error.endsWith(`(${MACHINE_EXPORT_TIMEOUT_MARK})`)
    ? ` Run llm-usage sync ${outcome.name} to wait for it.`
    : '';

  return {
    text: `Could not sync ${outcome.name} (${outcome.error}); using its usage from ${formatAge(now - syncedAt)}.${hint}`,
    stale: now - syncedAt >= STALE_CACHE_MS,
  };
}
