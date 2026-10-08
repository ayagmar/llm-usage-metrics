import { LOCAL_MACHINE_NAME, type MachineConfig } from '../config/user-config.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { readMachineCacheUsage, type MachineSyncState } from './machine-cache.js';
import { mergeMachineEvents } from './merge-machine-events.js';

export type MachineSelection = {
  includeLocal: boolean;
  /** Configured machines whose cached usage the run includes, in name order. */
  names: string[];
};

/**
 * Which machines a report counts. By default this one and every configured machine; a
 * run pointed at custom source directories counts only those. `--machine` picks
 * machines by name, `local` being this one.
 */
export function selectMachines(
  machines: Readonly<Record<string, MachineConfig>> | undefined,
  machineFilter: ReadonlySet<string> | undefined,
  options: { customSourceDirectories: boolean },
): MachineSelection {
  const configured = Object.keys(machines ?? {}).sort();

  if (!machineFilter) {
    return { includeLocal: true, names: options.customSourceDirectories ? [] : configured };
  }

  const known = new Set([LOCAL_MACHINE_NAME, ...configured]);
  const unknown = [...machineFilter].filter((name) => !known.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `Unknown machine(s) for --machine: ${unknown.join(', ')} (known: ${[...known].join(', ')})`,
    );
  }

  return {
    includeLocal: machineFilter.has(LOCAL_MACHINE_NAME),
    names: configured.filter((name) => machineFilter.has(name)),
  };
}

export type MachineUsageSummary = {
  name: string;
  /** False when its table sets enabled = false: read from cache, never synced. */
  enabled: boolean;
  /** Undefined when the machine was never synced. */
  state?: MachineSyncState;
  duplicateCount: number;
};

export type LoadedMachineUsage = {
  events: UsageEvent[];
  machines: MachineUsageSummary[];
  warnings: string[];
};

function toTimestampBound(date: string | undefined, offsetDays: number): string | undefined {
  if (date === undefined) {
    return undefined;
  }

  const bound = new Date(`${date}T00:00:00.000Z`);
  bound.setUTCDate(bound.getUTCDate() + offsetDays);
  return bound.toISOString();
}

/**
 * Reads the selected machines' cached events for the sources this run counts and leaves
 * out those already counted (see mergeMachineEvents). `since`/`until` are local dates;
 * the read is widened by the largest timezone offsets and the report's own date filter
 * does the rest.
 */
export async function loadMachineUsage(params: {
  names: readonly string[];
  /** Selected machines with enabled = false. */
  disabledNames?: ReadonlySet<string>;
  servedEvents: readonly UsageEvent[];
  sources: ReadonlySet<string>;
  since?: string;
  until?: string;
}): Promise<LoadedMachineUsage> {
  const window = {
    fromTimestamp: toTimestampBound(params.since, -1),
    toTimestamp: toTimestampBound(params.until, 2),
  };
  const warnings: string[] = [];
  const caches = await Promise.all(
    params.names.map(async (name) => {
      try {
        return { name, usage: await readMachineCacheUsage(name, window) };
      } catch (error) {
        warnings.push(
          `Left out machine ${name}: its cache cannot be read (${getErrorReason(error)})`,
        );
        return undefined;
      }
    }),
  );
  const readable = caches.filter((cache) => cache !== undefined);
  const merged = mergeMachineEvents(
    params.servedEvents,
    readable.map(({ name, usage }) => ({
      name,
      events: (usage?.events ?? []).filter((event) => params.sources.has(event.source)),
    })),
  );

  return {
    events: merged.flatMap((machine) =>
      machine.events.map((event) => ({ ...event, machine: machine.name })),
    ),
    machines: readable.map(({ name, usage }, index) => ({
      name,
      enabled: !params.disabledNames?.has(name),
      state: usage?.state,
      duplicateCount: merged[index].duplicateCount,
    })),
    warnings,
  };
}
