import type { EventKind } from '../../domain/session-event.js';
import type { ReplacedEventCounts } from '../../stream/cursor.js';
import {
  getReadPlanKey,
  isCount,
  isOptionalString,
  isReplacedEventCounts,
} from '../../stream/cursor-state.js';
import { asRecord } from '../../utils/as-record.js';

// The state a Claude cursor carries (`readJsonlFromStatefulCursor`): what the parse of the
// file so far keeps for the lines after the cursor. Everything here is checked on restore,
// since a cursor comes back from the caller's storage.

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  totalTokens: number;
};

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
  'totalTokens',
] as const satisfies readonly (keyof ClaudeUsage)[];

export type ClaudePendingEvent = {
  /** The dedup key; a later row with the same key replaces this one. */
  key: string;
  sessionId: string;
  timestamp: string;
  repoRoot?: string;
  provider?: string;
  model?: string;
  usage: ClaudeUsage;
  sequence: number;
  // Set only when the read yields usage records.
  messageId?: string;
  requestId?: string;
  rawProvider?: string;
  raw?: Record<string, unknown>;
};

/**
 * The usage of the rows before the cursor. Usage is yielded sorted at the end of the file,
 * the last row per key winning, so the events from the last row's key onward in sort
 * order stay open: the next read yields them again, with whatever rows after the cursor
 * change. The keys of the events before them are kept as hashes.
 */
export type ClaudeUsageState = {
  sequence: number;
  lastKey?: string;
  settledKeys: string;
  open: ClaudePendingEvent[];
  /** Timestamp and sequence of the last event before `open`: later events sort after it. */
  settledLast?: [string, number];
};

export type ClaudeCursorState = {
  /** The read's options; a cursor from a read with other options restarts. */
  plan: string;
  /** What the next read replaces of the events this read yielded. */
  replaced: ReplacedEventCounts;
  usage: ClaudeUsageState;
  /** Set when the read wanted any kind besides usage (`ClaudeSessionEvents.toState`). */
  session?: unknown;
};

export function getClaudeReadPlanKey(plan: {
  kinds: ReadonlySet<EventKind>;
  text: boolean;
  raw: boolean;
  records: boolean;
}): string {
  return getReadPlanKey(plan.kinds, plan.text, plan.raw, plan.records);
}

function isUsage(value: unknown): value is ClaudeUsage {
  const usage = asRecord(value);
  return usage !== undefined && USAGE_FIELDS.every((field) => isCount(usage[field]));
}

function isPendingEvent(value: unknown): value is ClaudePendingEvent {
  const event = asRecord(value);

  return (
    event !== undefined &&
    typeof event.key === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.timestamp === 'string' &&
    isOptionalString(event.repoRoot) &&
    isOptionalString(event.provider) &&
    isOptionalString(event.model) &&
    isUsage(event.usage) &&
    isCount(event.sequence) &&
    isOptionalString(event.messageId) &&
    isOptionalString(event.requestId) &&
    isOptionalString(event.rawProvider) &&
    (event.raw === undefined || asRecord(event.raw) !== undefined)
  );
}

function isSettledLast(value: unknown): value is [string, number] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      isCount(value[1]))
  );
}

function isUsageState(value: unknown): value is ClaudeUsageState {
  const usage = asRecord(value);

  return (
    usage !== undefined &&
    isCount(usage.sequence) &&
    isOptionalString(usage.lastKey) &&
    typeof usage.settledKeys === 'string' &&
    Array.isArray(usage.open) &&
    (usage.open as unknown[]).every(isPendingEvent) &&
    isSettledLast(usage.settledLast)
  );
}

/** The state when it is one this read's plan can resume from. */
export function parseClaudeCursorState(
  value: unknown,
  planKey: string,
): ClaudeCursorState | undefined {
  return isClaudeCursorState(value, planKey) ? value : undefined;
}

function isClaudeCursorState(value: unknown, planKey: string): value is ClaudeCursorState {
  const state = asRecord(value);

  return (
    state?.plan === planKey && isReplacedEventCounts(state.replaced) && isUsageState(state.usage)
  );
}
