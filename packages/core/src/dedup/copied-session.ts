import { isUsageEvent, type SessionEvent } from '../domain/session-event.js';
import type { UsageEvent } from '../domain/usage-event.js';
import { collect } from '../stream/collect.js';
import type { Stage } from '../stream/pipe.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';

// Everything but the session and the request ids: a copied event keeps its timestamp,
// model and usage. Keep in step with isSameUsage.
function getUsageIdentity(event: UsageEvent): string {
  return [
    event.timestamp,
    event.provider ?? '',
    event.model ?? '',
    event.inputTokens,
    event.outputTokens,
    event.reasoningTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.cacheWrite1hTokens,
    event.totalTokens,
  ].join('\0');
}

// A copy also keeps the logged message and request ids. An event stored or exported before
// events carried them has neither; a row can log only one of them.
function hasRequestIds(event: UsageEvent): boolean {
  return event.messageId !== undefined || event.requestId !== undefined;
}

function getRequestKey(event: UsageEvent): string | undefined {
  return hasRequestIds(event)
    ? JSON.stringify([event.messageId ?? null, event.requestId ?? null])
    : undefined;
}

function isSameUsage(left: UsageEvent, right: UsageEvent): boolean {
  return (
    left.totalTokens === right.totalTokens &&
    left.timestamp === right.timestamp &&
    left.model === right.model &&
    left.provider === right.provider &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.cacheWrite1hTokens === right.cacheWrite1hTokens
  );
}

// Two requests with different ids are distinct however alike their usage; an event
// without ids can be a copy of any event with the same usage.
function isCopyOf(left: UsageEvent, right: UsageEvent): boolean {
  return (
    isSameUsage(left, right) &&
    (!hasRequestIds(left) ||
      !hasRequestIds(right) ||
      (left.messageId === right.messageId && left.requestId === right.requestId))
  );
}

// The events that another session holds with the same timestamp and usage. Only events
// sharing a timestamp are compared, field by field, so a dataset whose sessions merely
// share timestamps builds no identities.
function findEventsOtherSessionsHold<E extends UsageEvent>(events: readonly E[]): Set<E> {
  const firstByTimestamp = new Map<string, E>();
  const sameTimestampGroups = new Map<string, E[]>();

  for (const event of events) {
    const first = firstByTimestamp.get(event.timestamp);

    if (first === undefined) {
      firstByTimestamp.set(event.timestamp, event);
      continue;
    }

    const group = sameTimestampGroups.get(event.timestamp);

    if (group) {
      group.push(event);
    } else {
      sameTimestampGroups.set(event.timestamp, [first, event]);
    }
  }

  const candidates = new Set<E>();

  for (const group of sameTimestampGroups.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if (
          group[left].sessionId !== group[right].sessionId &&
          isCopyOf(group[left], group[right])
        ) {
          candidates.add(group[left]);
          candidates.add(group[right]);
        }
      }
    }
  }

  return candidates;
}

// The identity each candidate is counted under: its usage and request ids. Candidates
// without ids, stored or exported before events carried them, take the request keys of
// the candidates with the same usage in sorted order, one key per event of their session
// and the last key again when they run out, so such a copy still matches its original.
// Keys the session's events with ids already hold come last: an event without ids in the
// same session is another request.
// Which of several distinct requests an id-less event stands for cannot be known; it can
// take the key of another session's distinct request, which then counts as the copy.
function getCopyIdentities<E extends UsageEvent>(candidates: ReadonlySet<E>): Map<E, string> {
  const keysByUsage = new Map<string, Set<string>>();
  const sessionKeysBySessionUsage = new Map<string, Set<string>>();

  for (const event of candidates) {
    const key = getRequestKey(event);

    if (key !== undefined) {
      const usageIdentity = getUsageIdentity(event);
      const sessionUsage = `${event.sessionId}\0${usageIdentity}`;
      const keys = keysByUsage.get(usageIdentity) ?? new Set<string>();
      const sessionKeys = sessionKeysBySessionUsage.get(sessionUsage) ?? new Set<string>();
      keys.add(key);
      sessionKeys.add(key);
      keysByUsage.set(usageIdentity, keys);
      sessionKeysBySessionUsage.set(sessionUsage, sessionKeys);
    }
  }

  const sortedKeysByUsage = new Map(
    [...keysByUsage].map(([usageIdentity, keys]) => [
      usageIdentity,
      [...keys].sort(compareByCodePoint),
    ]),
  );
  const idlessKeysBySessionUsage = new Map<string, string[]>();
  const idlessSeen = new Map<string, number>();
  const identities = new Map<E, string>();

  for (const event of candidates) {
    const usageIdentity = getUsageIdentity(event);
    let key = getRequestKey(event);

    if (key === undefined) {
      const sessionUsage = `${event.sessionId}\0${usageIdentity}`;
      let keys = idlessKeysBySessionUsage.get(sessionUsage);

      if (keys === undefined) {
        const sessionKeys = sessionKeysBySessionUsage.get(sessionUsage);
        const sortedKeys = sortedKeysByUsage.get(usageIdentity) ?? [];
        keys = sessionKeys
          ? [
              ...sortedKeys.filter((candidate) => !sessionKeys.has(candidate)),
              ...sortedKeys.filter((candidate) => sessionKeys.has(candidate)),
            ]
          : sortedKeys;
        idlessKeysBySessionUsage.set(sessionUsage, keys);
      }

      const seen = idlessSeen.get(sessionUsage) ?? 0;
      idlessSeen.set(sessionUsage, seen + 1);
      key = keys[Math.min(seen, keys.length - 1)] ?? '';
    }

    identities.set(event, `${usageIdentity}\0${key}`);
  }

  return identities;
}

/**
 * Counts once the events a session copied from another session under its own session id
 * (a Claude Desktop session "continued in new session" repeats the rows since the last
 * compaction). A copy keeps the timestamp, model, usage and logged message and request
 * ids; events whose ids differ are distinct requests and all count. Sessions are visited
 * oldest first, so the session whose first event is earlier keeps a copied event (on a
 * tie, the lower session id); within one session, identical events all count, as they
 * would without copies. Kept events stay in their input order.
 */
export function dedupeCopiedSessions<E extends UsageEvent | SessionEvent>(
  events: readonly E[],
): E[] {
  // Only usage is deduplicated; session starts come from usage too, so other kinds in the
  // input never change which session keeps a copy.
  const usageEvents = events.filter((event) => isUsageEvent(event));
  const candidates = findEventsOtherSessionsHold(usageEvents);

  if (candidates.size === 0) {
    return [...events];
  }

  const sessionStarts = new Map<string, string>();
  const candidatesBySession = new Map<string, (E & UsageEvent)[]>();

  for (const event of usageEvents) {
    const start = sessionStarts.get(event.sessionId);

    if (start === undefined || compareByCodePoint(event.timestamp, start) < 0) {
      sessionStarts.set(event.sessionId, event.timestamp);
    }

    if (candidates.has(event)) {
      const sessionCandidates = candidatesBySession.get(event.sessionId) ?? [];
      sessionCandidates.push(event);
      candidatesBySession.set(event.sessionId, sessionCandidates);
    }
  }

  const sessionsOldestFirst = [...candidatesBySession.keys()].sort(
    (left, right) =>
      compareByCodePoint(sessionStarts.get(left) ?? '', sessionStarts.get(right) ?? '') ||
      compareByCodePoint(left, right),
  );
  const identities = getCopyIdentities(candidates);
  const countedIdentities = new Map<string, number>();
  const copies = new Set<E & UsageEvent>();

  for (const sessionId of sessionsOldestFirst) {
    const sessionCounts = new Map<string, number>();

    for (const event of candidatesBySession.get(sessionId) ?? []) {
      const identity = identities.get(event) ?? '';
      const seen = (sessionCounts.get(identity) ?? 0) + 1;
      sessionCounts.set(identity, seen);

      if (seen <= (countedIdentities.get(identity) ?? 0)) {
        copies.add(event);
      }
    }

    for (const [identity, count] of sessionCounts) {
      countedIdentities.set(identity, Math.max(count, countedIdentities.get(identity) ?? 0));
    }
  }

  return events.filter((event) => !isUsageEvent(event) || !copies.has(event));
}

/**
 * The stage form of `dedupeCopiedSessions`. It buffers its whole input before yielding,
 * since which session keeps a copy depends on every session's first event; with message
 * text requested, that includes every message body.
 */
export function copiedSessions<E extends UsageEvent | SessionEvent>(): Stage<E, E> {
  return async function* (source) {
    yield* dedupeCopiedSessions(await collect(source));
  };
}
