import {
  normalizeSessionMetaFields,
  type EventKind,
  type SessionMetaFields,
} from '../domain/session-event.js';
import { recordSkippedRow } from './parse-diagnostics.js';
import type { SourceAdapter, SourceReadDiagnostics } from './source-adapter.js';

// Shared by the adapters that implement `readEvents`. Each piece sees every record a
// non-usage read parses, whichever kinds were requested; `kinds` only gates what is
// yielded and which reason codes are recorded.

const USAGE_ONLY: readonly EventKind[] = ['usage'];

/** The kinds an adapter declares; an adapter that declares none is usage-only. */
export function getDeclaredKinds(
  adapter: Pick<SourceAdapter, 'capabilities'>,
): readonly EventKind[] {
  return adapter.capabilities?.kinds ?? USAGE_ONLY;
}

/** The kinds a read yields: the requested ones the adapter declares, all of them by default. */
export function resolveReadKinds(
  requested: readonly EventKind[] | undefined,
  declared: readonly EventKind[],
): ReadonlySet<EventKind> {
  return new Set(requested ? requested.filter((kind) => declared.includes(kind)) : declared);
}

// Reason codes. `read` records the codes without one of these prefixes.
const NON_USAGE_REASON_PREFIXES = ['message_', 'tool_call_', 'session_meta_', 'other_'];

export const OTHER_JSON_PARSE_ERROR = 'other_json_parse_error';
export const TOOL_CALL_ORPHAN_RESULT = 'tool_call_orphan_result';

/** Whether `read` can record `reason`: the reason codes I7 compares. */
export function isReadReasonCode(reason: string): boolean {
  return !NON_USAGE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** Records `<kind>_<reason>`, only when the read yields `kind`. */
export function recordKindSkippedRow(
  diagnostics: SourceReadDiagnostics,
  kinds: ReadonlySet<EventKind>,
  kind: Exclude<EventKind, 'usage'>,
  reason: string,
): void {
  if (kinds.has(kind)) {
    recordSkippedRow(diagnostics, `${kind}_${reason}`);
  }
}

/**
 * A malformed line counts as `read` counts it (`json_parse_error`) only when the read
 * yields usage and the usage prefilter accepts the line.
 */
export function recordMalformedLine(
  diagnostics: SourceReadDiagnostics,
  kinds: ReadonlySet<EventKind>,
  isUsageLine: boolean,
): void {
  recordSkippedRow(
    diagnostics,
    isUsageLine && kinds.has('usage') ? 'json_parse_error' : OTHER_JSON_PARSE_ERROR,
  );
}

/**
 * Builds a non-usage event when the read yields its kind. A constructor that throws is
 * counted as `<kind>_event_creation_failed`.
 */
export function createKindEvent<Event>(
  diagnostics: SourceReadDiagnostics,
  kinds: ReadonlySet<EventKind>,
  kind: Exclude<EventKind, 'usage'>,
  create: () => Event,
): Event | undefined {
  if (!kinds.has(kind)) {
    return undefined;
  }

  try {
    return create();
  } catch {
    recordSkippedRow(diagnostics, `${kind}_event_creation_failed`);
    return undefined;
  }
}

/**
 * Joins a record's text blocks with a blank line, unaltered. A string is the whole text.
 * Blocks of other types (thinking, tool use) are left out; undefined when there is no
 * text block.
 */
export function joinTextBlocks(
  content: unknown,
  textBlockTypes: ReadonlySet<string>,
): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const block of content as unknown[]) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }

    const { type, text } = block as { type?: unknown; text?: unknown };

    if (typeof type === 'string' && textBlockTypes.has(type) && typeof text === 'string') {
      texts.push(text);
    }
  }

  return texts.length > 0 ? texts.join('\n\n') : undefined;
}

/**
 * Pairs tool calls with their results by call id. The first call with an id wins; a
 * result with no pending call is dropped, and counted as an orphan when no call with its
 * id was seen. Memory holds the calls still waiting plus one id per call.
 */
export class ToolCallPairing<Call> {
  private readonly pending = new Map<string, Call>();
  private readonly seenCallIds = new Set<string>();

  public constructor(
    private readonly diagnostics: SourceReadDiagnostics,
    private readonly kinds: ReadonlySet<EventKind>,
  ) {}

  /** Starts a call; false when a call with this id was already seen. */
  public start(callId: string, call: Call): boolean {
    if (this.seenCallIds.has(callId)) {
      return false;
    }

    this.seenCallIds.add(callId);
    this.pending.set(callId, call);
    return true;
  }

  /** The pending call a result answers, now complete; undefined when none is pending. */
  public finish(callId: string): Call | undefined {
    const call = this.pending.get(callId);

    if (call === undefined) {
      if (!this.seenCallIds.has(callId) && this.kinds.has('tool_call')) {
        recordSkippedRow(this.diagnostics, TOOL_CALL_ORPHAN_RESULT);
      }

      return undefined;
    }

    this.pending.delete(callId);
    return call;
  }

  /** At end of file: the calls never answered, in first-call order. */
  public takeUnanswered(): Call[] {
    const calls = [...this.pending.values()];
    this.pending.clear();
    return calls;
  }
}

/**
 * Turns the session facts each record states into partial session_meta fields: a field
 * is kept when it differs from the last value emitted for it in this file. Titles are
 * kept only when the read asked for text, and once a custom title is seen, AI titles
 * are ignored for the rest of the file.
 */
const SESSION_META_FIELDS = [
  'cwd',
  'title',
  'gitBranch',
  'agentVersion',
  'parentSessionId',
  'model',
  'rawProvider',
] as const satisfies readonly (keyof SessionMetaFields)[];

export class SessionMetaTracker {
  private readonly emitted: SessionMetaFields = {};
  private customTitleSeen = false;

  public constructor(private readonly text: boolean) {}

  /** The changed fields, or undefined when nothing changed. */
  public changes(
    stated: SessionMetaFields,
    { aiTitle = false }: { aiTitle?: boolean } = {},
  ): SessionMetaFields | undefined {
    const normalized = normalizeSessionMetaFields(stated);

    if (!this.text || (aiTitle && this.customTitleSeen)) {
      delete normalized.title;
    } else if (normalized.title !== undefined && !aiTitle) {
      this.customTitleSeen = true;
    }

    let changed: SessionMetaFields | undefined;

    for (const field of SESSION_META_FIELDS) {
      const value = normalized[field];

      if (value !== undefined && value !== this.emitted[field]) {
        this.emitted[field] = value;
        changed = { ...changed, [field]: value };
      }
    }

    return changed;
  }
}

/**
 * Timestamps for records that have none after the adapter's own fallback: such a record
 * takes the last valid timestamp seen earlier in the file. Before any, it is held, and
 * released when a record supplies a valid timestamp, ahead of anything that record
 * yields. What is still held at end of file had no timestamp to take.
 */
export class TimestampCarry<Held> {
  private lastTimestamp: string | undefined;
  private held: Held[] = [];

  /** Notes a record's valid timestamp; returns what was held for one, in order. */
  public advance(timestamp: string): Held[] {
    this.lastTimestamp = timestamp;

    if (this.held.length === 0) {
      return [];
    }

    const released = this.held;
    this.held = [];
    return released;
  }

  /** The timestamp a record without one takes, or undefined after holding `item`. */
  public carry(item: Held): string | undefined {
    if (this.lastTimestamp === undefined) {
      this.held.push(item);
    }

    return this.lastTimestamp;
  }

  /** At end of file: what is still held, to count as `<kind>_invalid_timestamp`. */
  public takeUnreleased(): Held[] {
    const unreleased = this.held;
    this.held = [];
    return unreleased;
  }
}
