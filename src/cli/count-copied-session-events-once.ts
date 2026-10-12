import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';

// Everything but the session: a copied event keeps its timestamp, model and usage.
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

/**
 * Counts once the events a session copied from another session under its own session id
 * (a Claude `/branch` or `--fork-session` transcript repeats the rows it was branched
 * from). Sessions are visited oldest first, so the session that started earlier keeps a
 * copied event; within one session, identical events all count, as they would without
 * copies. Kept events stay in their input order.
 */
export function countCopiedSessionEventsOnce(events: readonly UsageEvent[]): UsageEvent[] {
  // Only an event whose timestamp another session also has can be a copy.
  const sessionByTimestamp = new Map<string, string>();
  const sharedTimestamps = new Set<string>();

  for (const event of events) {
    const sessionId = sessionByTimestamp.get(event.timestamp);

    if (sessionId === undefined) {
      sessionByTimestamp.set(event.timestamp, event.sessionId);
    } else if (sessionId !== event.sessionId) {
      sharedTimestamps.add(event.timestamp);
    }
  }

  if (sharedTimestamps.size === 0) {
    return [...events];
  }

  const sessionStarts = new Map<string, string>();
  const candidatesBySession = new Map<string, UsageEvent[]>();

  for (const event of events) {
    const start = sessionStarts.get(event.sessionId);

    if (start === undefined || compareByCodePoint(event.timestamp, start) < 0) {
      sessionStarts.set(event.sessionId, event.timestamp);
    }

    if (sharedTimestamps.has(event.timestamp)) {
      const candidates = candidatesBySession.get(event.sessionId) ?? [];
      candidates.push(event);
      candidatesBySession.set(event.sessionId, candidates);
    }
  }

  const sessionsOldestFirst = [...candidatesBySession.keys()].sort(
    (left, right) =>
      compareByCodePoint(sessionStarts.get(left) ?? '', sessionStarts.get(right) ?? '') ||
      compareByCodePoint(left, right),
  );
  const countedIdentities = new Map<string, number>();
  const copies = new Set<UsageEvent>();

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
