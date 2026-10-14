import type { CostMode, UsageEvent } from '../domain/usage-event.js';
import { computeEventContentHash } from './content-hash.js';

type HashedEvent = UsageEvent & { costMode: CostMode };

export function addHashCount(target: Map<string, number>, hash: string, count: number): void {
  if (count <= 0) {
    return;
  }

  target.set(hash, (target.get(hash) ?? 0) + count);
}

/**
 * Leaves out a file's events that `countedHashes` already counts, per content hash, and
 * adds the rest to it; repeats within the file are kept. An identical content hash
 * covers the session id and timestamp, so it is the same event, not a lookalike: e.g. a
 * pi fork's copy of a parent session that is also counted from the parent or another fork.
 */
export function takeUncountedEvents<E extends HashedEvent>(
  events: readonly E[],
  countedHashes: Map<string, number>,
): E[] {
  const fileHashCounts = new Map<string, number>();
  const keptHashes: string[] = [];
  const keptEvents = events.filter((event) => {
    const hash = computeEventContentHash(event);
    const seen = (fileHashCounts.get(hash) ?? 0) + 1;
    fileHashCounts.set(hash, seen);

    if (seen <= (countedHashes.get(hash) ?? 0)) {
      return false;
    }

    keptHashes.push(hash);
    return true;
  });

  for (const hash of keptHashes) {
    addHashCount(countedHashes, hash, 1);
  }

  return keptEvents;
}

/** Counts an event that several files repeat once, from the first file holding it. */
export function dedupeRepeatedAcrossFiles<E extends HashedEvent>(
  eventsByFile: readonly (readonly E[])[],
): E[] {
  // Only an event whose session has events in another file can be a repeat, so only
  // the files holding such sessions are hashed.
  const fileIndexBySession = new Map<string, number>();
  const sharedSessions = new Set<string>();

  eventsByFile.forEach((events, fileIndex) => {
    for (const event of events) {
      const ownerIndex = fileIndexBySession.get(event.sessionId);

      if (ownerIndex === undefined) {
        fileIndexBySession.set(event.sessionId, fileIndex);
      } else if (ownerIndex !== fileIndex) {
        sharedSessions.add(event.sessionId);
      }
    }
  });

  const countedHashes = new Map<string, number>();

  return eventsByFile.flatMap((events) =>
    events.some((event) => sharedSessions.has(event.sessionId))
      ? takeUncountedEvents(events, countedHashes)
      : events,
  );
}
