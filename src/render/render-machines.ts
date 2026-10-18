import type { MachineConfig } from '../config/user-config.js';
import type { MachineSyncState } from '../machines/machine-cache.js';
import type { MachineUsageSummary } from '../machines/load-machine-usage.js';
import { MACHINE_EXPORT_TIMEOUT_MARK } from '../machines/machine-ssh.js';
import type { MachineSyncOutcome } from '../machines/sync-machine.js';
import { pluralize } from '@ayagmar/agent-sessions/internal';
import { formatInteger } from './format-number.js';
import { padEndVisible, visibleWidth } from './table-text-layout.js';

const MAX_REASON_LENGTH = 300;

/** Keeps a long sync error to one readable line. */
function formatReason(error: string): string {
  return error.length > MAX_REASON_LENGTH ? `${error.slice(0, MAX_REASON_LENGTH)}…` : error;
}

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
  return `${pluralize(fileCount, 'file')}, ${pluralize(eventCount, 'event')}`;
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
        : `${pluralize(result.receivedFileCount, 'file')} updated, ${formatInteger(result.removedFileCount)} removed`;

    return [
      `✓ ${outcome.name}: ${changes}; ${formatCachedTotals(result.fileCount, result.eventCount)} cached${formatRemoteVersion(outcome.state)}`,
      ...outcome.remoteWarnings.map((warning) => `  ${outcome.name} warned: ${warning}`),
    ];
  }

  const cacheNote =
    outcome.state.syncedAt === undefined
      ? 'nothing cached yet'
      : `reports keep its usage from ${formatAge(now - outcome.state.syncedAt)}`;

  return [`✗ ${outcome.name}: ${formatReason(outcome.error)} (${cacheNote})`];
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
    return state?.lastError ? `never synced: ${formatReason(state.lastError)}` : 'never synced';
  }

  const synced = `synced ${formatAge(now - state.syncedAt)}, ${formatCachedTotals(entry.fileCount, entry.eventCount)}`;

  if (state.lastError && (state.attemptedAt ?? 0) >= state.syncedAt) {
    return `${synced}; last attempt failed ${formatAge(now - (state.attemptedAt ?? 0))}: ${formatReason(state.lastError)}`;
  }

  return synced;
}

export function renderMachineList(entries: readonly MachineListEntry[], now: number): string[] {
  if (entries.length === 0) {
    return ['No machines configured.', 'Add one with: llm-usage machine add <name> [user@host]'];
  }

  const nameWidth = Math.max(...entries.map((entry) => visibleWidth(entry.name)));
  const sshWidth = Math.max(...entries.map((entry) => visibleWidth(entry.machine.ssh)));

  return entries.map(
    (entry) =>
      `${padEndVisible(entry.name, nameWidth)}  ${padEndVisible(entry.machine.ssh, sshWidth)}  ${describeMachineStatus(entry, now)}`,
  );
}

function describeIncludedMachine(
  machine: MachineUsageSummary,
  now: number,
  localVersion: string,
): string {
  const { state } = machine;

  if (!machine.enabled) {
    return state?.syncedAt === undefined
      ? `${machine.name} (disabled, nothing cached)`
      : `${machine.name} (disabled, usage from ${formatAge(now - state.syncedAt)})`;
  }

  if (state?.syncedAt === undefined) {
    // A failed first sync gets its own line with the reason.
    return state?.lastError === undefined
      ? `${machine.name} (never synced; run llm-usage sync ${machine.name})`
      : `${machine.name} (never synced)`;
  }

  const details = [`synced ${formatAge(now - state.syncedAt)}`];

  // Parsers change between versions, so a session copied to both machines may not match
  // exactly. The merge matches them by timestamp when the versions differ or are unrecorded.
  if (state.cliVersion && state.cliVersion !== localVersion) {
    details.push(
      state.parserVersions
        ? `llm-usage-metrics ${state.cliVersion} there; sessions it parses with other parser versions are matched by timestamp`
        : `llm-usage-metrics ${state.cliVersion} there; shared sessions are matched by timestamp until it is synced after updating llm-usage`,
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
  const leftOutCount = machines.reduce(
    (sum, machine) => sum + machine.duplicateCount + machine.skewDroppedCount,
    0,
  );
  const duplicates =
    leftOutCount > 0 ? `; left out ${pluralize(leftOutCount, 'event')} already counted` : '';

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
      text: `Could not sync ${outcome.name} (${formatReason(outcome.error)}); it has no usage cached yet.`,
      stale: true,
    };
  }

  // A remote that needs longer than a report waits can still be synced by hand.
  const hint = outcome.error.endsWith(`(${MACHINE_EXPORT_TIMEOUT_MARK})`)
    ? ` Run llm-usage sync ${outcome.name} to wait for it.`
    : '';

  return {
    text: `Could not sync ${outcome.name} (${formatReason(outcome.error)}); using its usage from ${formatAge(now - syncedAt)}.${hint}`,
    stale: now - syncedAt >= STALE_CACHE_MS,
  };
}

/**
 * Describes a failed sync a report did not retry (it was recent, or --no-sync), from the
 * machine's stored state, with the same note/warning split as a refresh failure.
 */
export function formatStoredSyncFailure(
  machine: MachineUsageSummary,
  now: number,
): { text: string; stale: boolean } | undefined {
  const { state } = machine;

  if (!machine.enabled || state?.lastError === undefined) {
    return undefined;
  }

  if (state.syncedAt === undefined) {
    return {
      text: `${machine.name}: never synced (${formatReason(state.lastError)}). Run llm-usage sync ${machine.name} to retry.`,
      stale: true,
    };
  }

  if ((state.attemptedAt ?? 0) < state.syncedAt) {
    return undefined;
  }

  return {
    text: `${machine.name}: last sync failed (${formatReason(state.lastError)}); using its usage from ${formatAge(now - state.syncedAt)}. Run llm-usage sync ${machine.name} to retry.`,
    stale: now - state.syncedAt >= STALE_CACHE_MS,
  };
}
