import { LOCAL_MACHINE_NAME, type MachineConfig } from '../config/user-config.js';
import { getParserVersion, type SourceAdapter } from '@ayagmar/agent-sessions';

import { pluralize, toTerminalLine } from '@ayagmar/agent-sessions/internal';
import type { UsageEvent } from '../domain/usage-event.js';
import { getUtcMidnightIso } from '../utils/date-key.js';
import { getErrorReason } from '../utils/get-error-reason.js';
import { readMachineCacheUsage, type MachineSyncState } from './machine-cache.js';
import { mergeMachineEvents, type MergedMachineEvents } from './merge-machine-events.js';

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
  /** Events left out because a differently parsed copy of them is already counted. */
  skewDroppedCount: number;
};

export type LoadedMachineUsage = {
  events: UsageEvent[];
  machines: MachineUsageSummary[];
  warnings: string[];
  notes: string[];
};

function toTimestampBound(date: string | undefined, offsetDays: number): string | undefined {
  return date === undefined ? undefined : getUtcMidnightIso(date, offsetDays);
}

function formatParserSkew(machine: MergedMachineEvents): string | undefined {
  if (machine.skews.length === 0) {
    return undefined;
  }

  // The versions come from the machine's export.
  const skews = machine.skews.map(({ source, version, servedBy, servedVersion }) =>
    toTerminalLine(
      `${source} ${version} there, ${servedVersion} on ${servedBy === LOCAL_MACHINE_NAME ? 'this machine' : servedBy}`,
    ),
  );

  return `${machine.name} parses with other parser versions (${skews.join('; ')}): left out ${pluralize(machine.skewDroppedCount, 'event')} of sessions already counted, matched by timestamp; update llm-usage on both machines`;
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
  /** The sources this run counts, with the parser versions the served events come from. */
  adapters: readonly Pick<SourceAdapter, 'id' | 'parserVersion'>[];
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
  const sources = new Set(params.adapters.map((adapter) => adapter.id));
  const merged = mergeMachineEvents(
    params.servedEvents,
    readable.map(({ name, usage }) => ({
      name,
      events: (usage?.events ?? []).filter((event) => sources.has(event.source)),
      parserVersions: usage?.state.parserVersions,
    })),
    Object.fromEntries(params.adapters.map((adapter) => [adapter.id, getParserVersion(adapter)])),
  );
  const notes: string[] = [];

  readable.forEach(({ name, usage }, index) => {
    // A machine never synced has its own note.
    if (usage?.state.syncedAt !== undefined && usage.state.parserVersions === undefined) {
      notes.push(`sync ${name} after updating llm-usage on it to record its parser versions`);
    }

    const skewWarning = formatParserSkew(merged[index]);

    if (skewWarning) {
      (params.disabledNames?.has(name) ? notes : warnings).push(skewWarning);
    }
  });

  return {
    events: merged.flatMap((machine) =>
      machine.events.map((event) => ({ ...event, machine: machine.name })),
    ),
    machines: readable.map(({ name, usage }, index) => ({
      name,
      enabled: !params.disabledNames?.has(name),
      state: usage?.state,
      duplicateCount: merged[index].duplicateCount,
      skewDroppedCount: merged[index].skewDroppedCount,
    })),
    warnings,
    notes,
  };
}
