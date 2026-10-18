import type { ReplacedEventCounts } from '../../stream/cursor.js';
import { isOptionalString, isReplacedEventCounts } from '../../stream/cursor-state.js';
import { asRecord } from '../../utils/as-record.js';

// The state a pi cursor carries (`readJsonlFromStatefulCursor`). Everything here is
// checked on restore, since a cursor comes back from the caller's storage.

/** Entries of a forked session older than its header were copied from the parent. */
export type PiFork = {
  forkedAtMs: number;
  /** The same report counts the parent: it exists and lies under a discovery root. */
  parentCounted: boolean;
  /** Undefined when the parent's file name does not follow pi's naming. */
  parentSessionId?: string;
};

/** What the header and model changes so far state for the records after them. */
export type PiSessionState = {
  sessionId?: string;
  sessionTimestamp?: string;
  /** Set for forked sessions. */
  fork?: PiFork;
  repoRoot?: string;
  provider?: string;
  model?: string;
};

export type PiCursorState = {
  /** The read's options; a cursor from a read with other options restarts. */
  plan: string;
  /** What the next read replaces of the events this read yielded. */
  replaced: ReplacedEventCounts;
  session: PiSessionState;
  /** Set when the read wanted any kind besides usage (`PiSessionEvents.toState`). */
  events?: unknown;
};

function isFork(value: unknown): value is PiFork | undefined {
  if (value === undefined) {
    return true;
  }

  const fork = asRecord(value);

  return (
    fork !== undefined &&
    typeof fork.forkedAtMs === 'number' &&
    typeof fork.parentCounted === 'boolean' &&
    isOptionalString(fork.parentSessionId)
  );
}

function isSessionState(value: unknown): value is PiSessionState {
  const state = asRecord(value);

  return (
    state !== undefined &&
    isOptionalString(state.sessionId) &&
    isOptionalString(state.sessionTimestamp) &&
    isFork(state.fork) &&
    isOptionalString(state.repoRoot) &&
    isOptionalString(state.provider) &&
    isOptionalString(state.model)
  );
}

/** The state when it is one this read's plan can resume from. */
export function parsePiCursorState(value: unknown, planKey: string): PiCursorState | undefined {
  return isPiCursorState(value, planKey) ? value : undefined;
}

function isPiCursorState(value: unknown, planKey: string): value is PiCursorState {
  const state = asRecord(value);

  return (
    state?.plan === planKey &&
    isReplacedEventCounts(state.replaced) &&
    isSessionState(state.session)
  );
}
