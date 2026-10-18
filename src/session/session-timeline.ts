import type { UsageEvent } from '../domain/usage-event.js';
import type { MessageEvent, ToolCallEvent } from '@ayagmar/agent-sessions';
import type { TokenBuckets } from '../domain/usage-report-row.js';
import { compareByCodePoint, normalizeOptionalModel } from '@ayagmar/agent-sessions/internal';
import { addUsd } from '../utils/usd-math.js';

/** One priced request, with the session's cost up to and including it. */
export type TimelineUsageRow = TokenBuckets & {
  kind: 'usage';
  timestamp: string;
  model?: string;
  costUsd?: number;
  /** The summed cost of this and every earlier request; omitted while none is priced. */
  runningCostUsd?: number;
  /** True when this or an earlier request has no price. */
  runningCostIncomplete?: boolean;
};

export type TimelineToolCallRow = Pick<ToolCallEvent, 'kind' | 'timestamp' | 'name' | 'status'>;

export type TimelineMessageRow = Pick<MessageEvent, 'kind' | 'timestamp' | 'role'>;

export type SessionTimelineRow = TimelineUsageRow | TimelineToolCallRow | TimelineMessageRow;

/** The live-read events a timeline interleaves with its usage. */
export type TimelineLiveEvent = ToolCallEvent | MessageEvent;

// A request's tool calls and reply share its timestamp in some sources; they follow it.
const KIND_ORDER: Record<SessionTimelineRow['kind'], number> = {
  usage: 0,
  message: 1,
  tool_call: 2,
};

function toUsageRows(events: readonly UsageEvent[]): TimelineUsageRow[] {
  let runningCostUsd: number | undefined;
  let runningCostIncomplete = false;

  return events.map((event) => {
    if (event.costUsd === undefined) {
      runningCostIncomplete = true;
    } else {
      runningCostUsd = addUsd(runningCostUsd ?? 0, event.costUsd);
    }

    return {
      kind: 'usage',
      timestamp: event.timestamp,
      model: normalizeOptionalModel(event.model),
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      reasoningTokens: event.reasoningTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      totalTokens: event.totalTokens,
      costUsd: event.costUsd,
      runningCostUsd,
      runningCostIncomplete: runningCostIncomplete || undefined,
    };
  });
}

function toLiveRow(event: TimelineLiveEvent): TimelineToolCallRow | TimelineMessageRow {
  return event.kind === 'tool_call'
    ? { kind: event.kind, timestamp: event.timestamp, name: event.name, status: event.status }
    : { kind: event.kind, timestamp: event.timestamp, role: event.role };
}

function compareTimelineRows(left: SessionTimelineRow, right: SessionTimelineRow): number {
  return (
    compareByCodePoint(left.timestamp, right.timestamp) ||
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
  );
}

/**
 * One session's usage events and live-read tool calls and messages, in time order. The
 * running cost follows the usage events' timestamps, so the events are sorted first.
 */
export function buildSessionTimeline(
  usageEvents: readonly UsageEvent[],
  liveEvents: readonly TimelineLiveEvent[],
): SessionTimelineRow[] {
  const sortedUsage = [...usageEvents].sort((left, right) =>
    compareByCodePoint(left.timestamp, right.timestamp),
  );

  // Array sort is stable: rows of one kind at one timestamp keep their read order.
  return [...toUsageRows(sortedUsage), ...liveEvents.map(toLiveRow)].sort(compareTimelineRows);
}
