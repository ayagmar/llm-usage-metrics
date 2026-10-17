import { getEventSessionKey, LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import { computeEventContentHash } from '@ayagmar/agent-sessions';
import { addHashCount, takeUncountedEvents } from '@ayagmar/agent-sessions/internal';

/** Source id → the parser version a machine read it with (`getParserVersion`). */
export type ParserVersions = Readonly<Record<string, string>>;

export type MachineEvents = {
  name: string;
  events: UsageEvent[];
  /** Undefined when the machine's last sync did not record them (an older export). */
  parserVersions?: ParserVersions;
};

/** A source this machine parses with another version than the side that served a session. */
export type ParserSkew = {
  source: string;
  version: string;
  servedBy: string;
  servedVersion: string;
};

export type MergedMachineEvents = {
  name: string;
  /** Events counted from this machine. */
  events: UsageEvent[];
  /** Events left out because an identical one is already counted. */
  duplicateCount: number;
  /** Events left out because a differently parsed copy of them is already counted. */
  skewDroppedCount: number;
  skews: ParserSkew[];
};

type Server = { name: string; parserVersions?: ParserVersions };

function countKeys(
  events: readonly UsageEvent[],
  toKey: (event: UsageEvent) => string,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    const key = toKey(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/**
 * Another parser version can split tokens and resolve models differently, but keeps when
 * a turn happened.
 */
function toTurnKey(event: UsageEvent): string {
  return event.timestamp;
}

function groupBySession(events: readonly UsageEvent[]): Map<string, UsageEvent[]> {
  const groups = new Map<string, UsageEvent[]>();

  for (const event of events) {
    const key = getEventSessionKey(event);
    const group = groups.get(key);

    if (group) {
      group.push(event);
    } else {
      groups.set(key, [event]);
    }
  }

  return groups;
}

/** Both sides recorded a version for the source, and they differ. */
function findSkew(source: string, machine: Server, server: Server): ParserSkew | undefined {
  const version = machine.parserVersions?.[source];
  const servedVersion = server.parserVersions?.[source];

  return version !== undefined && servedVersion !== undefined && version !== servedVersion
    ? { source, version, servedBy: server.name, servedVersion }
    : undefined;
}

/**
 * Combines other machines' events with the ones already counted here. The same session
 * can reach several machines (a synced or copied ~/.claude, a shared home), so a
 * machine's event is left out when an identical event (same content hash) is already
 * counted, counting each served event once. Machines are taken in order, each against
 * everything served before it. A session continued on another machine keeps its new
 * events: their timestamps differ. Only sessions present on both sides are hashed.
 *
 * When the machine parses the session's source with another parser version than the
 * side that served the session first, the copies hash differently; its events are then
 * matched on timestamp instead, and counted in `skewDroppedCount`.
 */
export function mergeMachineEvents(
  servedEvents: readonly UsageEvent[],
  machines: readonly MachineEvents[],
  servedParserVersions?: ParserVersions,
): MergedMachineEvents[] {
  const local: Server = { name: LOCAL_MACHINE_NAME, parserVersions: servedParserVersions };
  const servedBySession = groupBySession(servedEvents);
  const serverBySession = new Map<string, Server>();
  const servedHashesBySession = new Map<string, Map<string, number>>();
  const merged: MergedMachineEvents[] = [];

  for (const machine of machines) {
    const kept: UsageEvent[] = [];
    const skews = new Map<string, ParserSkew>();
    let duplicateCount = 0;
    let skewDroppedCount = 0;

    for (const [sessionKey, events] of groupBySession(machine.events)) {
      const served = servedBySession.get(sessionKey);

      if (!served) {
        servedBySession.set(sessionKey, [...events]);
        serverBySession.set(sessionKey, machine);
        kept.push(...events);
        continue;
      }

      let servedHashes = servedHashesBySession.get(sessionKey);
      const skew = findSkew(events[0].source, machine, serverBySession.get(sessionKey) ?? local);

      if (skew) {
        skews.set(JSON.stringify([skew.source, skew.servedBy]), skew);
        const available = countKeys(served, toTurnKey);

        for (const event of events) {
          const key = toTurnKey(event);
          const count = available.get(key) ?? 0;

          if (count > 0) {
            available.set(key, count - 1);
            skewDroppedCount += 1;
            continue;
          }

          kept.push(event);
          served.push(event);

          if (servedHashes) {
            addHashCount(servedHashes, computeEventContentHash(event), 1);
          }
        }

        continue;
      }

      if (!servedHashes) {
        servedHashes = countKeys(served, computeEventContentHash);
        servedHashesBySession.set(sessionKey, servedHashes);
      }

      // Matched against what was served before this machine, one served event each.
      const uncounted = takeUncountedEvents(events, servedHashes);
      duplicateCount += events.length - uncounted.length;
      kept.push(...uncounted);
      served.push(...uncounted);
    }

    merged.push({
      name: machine.name,
      events: kept,
      duplicateCount,
      skewDroppedCount,
      skews: [...skews.values()],
    });
  }

  return merged;
}
