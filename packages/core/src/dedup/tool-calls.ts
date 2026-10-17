import type { ToolCallEvent } from '../domain/session-event.js';

/**
 * Counts once a tool call that sessions repeat under the same call id within a source (a
 * resumed or forked transcript copies its parent's calls). The first copy read is kept,
 * with the status of the first copy that has a result; calls without an id are all kept.
 * Kept calls stay in their input order.
 */
export function dedupeToolCalls(calls: readonly ToolCallEvent[]): ToolCallEvent[] {
  const byId = new Map<string, number>();
  const counted: ToolCallEvent[] = [];

  for (const call of calls) {
    if (call.toolCallId === undefined) {
      counted.push(call);
      continue;
    }

    const key = `${call.source}\0${call.toolCallId}`;
    const index = byId.get(key);

    if (index === undefined) {
      byId.set(key, counted.length);
      counted.push(call);
    } else if (counted[index].status === 'unknown' && call.status !== 'unknown') {
      counted[index] = { ...counted[index], status: call.status };
    }
  }

  return counted;
}
