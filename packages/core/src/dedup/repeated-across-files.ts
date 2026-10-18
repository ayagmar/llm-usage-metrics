import { isUsageEvent, type SessionEvent } from '../domain/session-event.js';
import type { CostMode, UsageEvent } from '../domain/usage-event.js';
import type { Stage } from '../stream/pipe.js';
import { computeEventContentHash } from './content-hash.js';

type HashedEvent = UsageEvent & { costMode?: CostMode };
// Usage events are deduplicated; other kinds pass through where they are.
type DedupedEvent = HashedEvent | SessionEvent;

function isHashedEvent<E extends DedupedEvent>(event: E): event is E & HashedEvent {
  return isUsageEvent(event);
}

export function addHashCount(target: Map<string, number>, hash: string, count: number): void {
  if (count <= 0) {
    return;
  }

  target.set(hash, (target.get(hash) ?? 0) + count);
}

function hashUsageEvent(event: DedupedEvent): string | undefined {
  return isHashedEvent(event) ? computeEventContentHash(event) : undefined;
}

/**
 * Leaves out a file's events that `countedHashes` already counts, per content hash, and
 * adds the rest to it; repeats within the file are kept. An identical content hash
 * covers the session id and timestamp, so it is the same event, not a lookalike: e.g. a
 * pi fork's copy of a parent session that is also counted from the parent or another fork.
 * By default only usage events are hashed; `toHash` returns undefined for an event to keep.
 */
export function takeUncountedEvents<E extends DedupedEvent>(
  events: readonly E[],
  countedHashes: Map<string, number>,
  toHash: (event: E) => string | undefined = hashUsageEvent,
): E[] {
  const fileHashCounts = new Map<string, number>();
  const keptHashes: string[] = [];
  const keptEvents = events.filter((event) => {
    const hash = toHash(event);

    if (hash === undefined) {
      return true;
    }

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
export function dedupeRepeatedAcrossFiles<E extends DedupedEvent>(
  eventsByFile: readonly (readonly E[])[],
): E[] {
  // Only an event whose session has events in another file can be a repeat, so only
  // the files holding such sessions are hashed.
  const fileIndexBySession = new Map<string, number>();
  const sharedSessions = new Set<string>();

  eventsByFile.forEach((events, fileIndex) => {
    for (const event of events) {
      if (!isHashedEvent(event)) {
        continue;
      }

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
    events.some((event) => isHashedEvent(event) && sharedSessions.has(event.sessionId))
      ? takeUncountedEvents(events, countedHashes)
      : events,
  );
}

/**
 * The stage form of `dedupeRepeatedAcrossFiles`: one batch per file, in file order. It
 * hashes every file and yields a batch's kept events before pulling the next batch, so it
 * keeps only the running hash counts. Equal to the array form as long as different
 * sessions never share a content hash, which the hash already assumes.
 */
export function repeatedAcrossFiles<E extends DedupedEvent>(): Stage<readonly E[], E> {
  return async function* (batches) {
    const countedHashes = new Map<string, number>();

    for await (const events of batches) {
      yield* takeUncountedEvents(events, countedHashes);
    }
  };
}
