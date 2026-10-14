import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';

// Everything but the session: a copied event keeps its timestamp, model and usage.
// Keep in step with isCopyOf.
function getCopyIdentity(event: UsageEvent): string {
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

function isCopyOf(left: UsageEvent, right: UsageEvent): boolean {
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

/**
 * Counts once the events a session copied from another session under its own session id
 * (a Claude Desktop session "continued in new session" repeats the rows since the last
 * compaction). Sessions are visited oldest first, so the session whose first event is
 * earlier keeps a copied event (on a tie, the lower session id); within one session,
 * identical events all count, as they would without copies. Kept events stay in their
 * input order.
 */
export function dedupeCopiedSessions<E extends UsageEvent>(events: readonly E[]): E[] {
  const candidates = findEventsOtherSessionsHold(events);

  if (candidates.size === 0) {
    return [...events];
  }

  const sessionStarts = new Map<string, string>();
  const candidatesBySession = new Map<string, E[]>();

  for (const event of events) {
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
  const countedIdentities = new Map<string, number>();
  const copies = new Set<E>();

  for (const sessionId of sessionsOldestFirst) {
    const sessionCounts = new Map<string, number>();

    for (const event of candidatesBySession.get(sessionId) ?? []) {
      const identity = getCopyIdentity(event);
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

  return events.filter((event) => !copies.has(event));
}
