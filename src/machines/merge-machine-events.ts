import { getEventSessionKey, type UsageEvent } from '../domain/usage-event.js';
import { computeEventContentHash } from '../persistence/event-store.js';

export type MachineEvents = {
  name: string;
  events: UsageEvent[];
};

export type MergedMachineEvents = {
  name: string;
  /** Events counted from this machine. */
  events: UsageEvent[];
  /** Events left out because an identical one is already counted. */
  duplicateCount: number;
};

function countHashes(events: readonly UsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const event of events) {
    const hash = computeEventContentHash(event);
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }

  return counts;
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

/**
 * Combines other machines' events with the ones already counted here. The same session
 * can reach several machines (a synced or copied ~/.claude, a shared home), so a
 * machine's event is left out when an identical event (same content hash) is already
 * counted, counting each served event once. Machines are taken in order, each against
 * everything served before it. A session continued on another machine keeps its new
 * events: their timestamps differ. Only sessions present on both sides are hashed.
 */
export function mergeMachineEvents(
  servedEvents: readonly UsageEvent[],
  machines: readonly MachineEvents[],
): MergedMachineEvents[] {
  const servedBySession = groupBySession(servedEvents);
  const servedHashesBySession = new Map<string, Map<string, number>>();
  const merged: MergedMachineEvents[] = [];

  for (const machine of machines) {
    const kept: UsageEvent[] = [];
    let duplicateCount = 0;

    for (const [sessionKey, events] of groupBySession(machine.events)) {
      const served = servedBySession.get(sessionKey);

      if (!served) {
        servedBySession.set(sessionKey, [...events]);
        kept.push(...events);
        continue;
      }

      let servedHashes = servedHashesBySession.get(sessionKey);

      if (!servedHashes) {
        servedHashes = countHashes(served);
        servedHashesBySession.set(sessionKey, servedHashes);
      }

      // Matched against what was served before this machine, one served event each.
      const available = new Map(servedHashes);

      for (const event of events) {
        const hash = computeEventContentHash(event);
        const count = available.get(hash) ?? 0;

        if (count > 0) {
          available.set(hash, count - 1);
          duplicateCount += 1;
          continue;
        }

        kept.push(event);
        served.push(event);
        servedHashes.set(hash, (servedHashes.get(hash) ?? 0) + 1);
      }
    }

    merged.push({ name: machine.name, events: kept, duplicateCount });
  }

  return merged;
}
