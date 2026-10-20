import {
  normalizeNonNegativeInteger,
  normalizeTimestamp,
  stripControlCharacters,
} from './normalization.js';
import type { NumberLike } from './normalization.js';
import {
  createUsageEvent,
  normalizeOptionalModel,
  normalizeSourceId,
  type SourceId,
  type UsageEvent,
  type UsageEventInput,
} from './usage-event.js';

/** The kind of a `SessionEvent`: its `kind` field. */
export type EventKind = 'usage' | 'message' | 'tool_call' | 'session_meta';

/** Every event kind, in a fixed order. Frozen: adapters share it as their declared kinds. */
export const EVENT_KINDS: readonly EventKind[] = Object.freeze([
  'usage',
  'message',
  'tool_call',
  'session_meta',
]);

type EventBase = {
  source: SourceId;
  sessionId: string;
  timestamp: string;
  /** The parsed source record, only when the read asked for `raw`. */
  raw?: unknown;
};

/**
 * A usage event as a `SessionEvent` (`kind: 'usage'`): the `UsageEvent` fields, in the same
 * order, with the ids set when the source has them, followed by the logged provider.
 */
export type UsageRecord = EventBase & { kind: 'usage' } & Omit<UsageEvent, keyof EventBase> & {
    /** The provider as logged; undefined when the adapter inferred it. */
    rawProvider?: string;
  };

/** One user, assistant or system message. Its text is set only when the read asked for `text`. */
export type MessageEvent = EventBase & {
  kind: 'message';
  role: 'user' | 'assistant' | 'system';
  messageId?: string;
  model?: string;
  /** The length of the joined text, also when `text` is not requested. */
  textLength: number;
  /** Only with `{ text: true }`: the record's text blocks joined, unaltered. */
  text?: string;
};

/** How a tool call ended, as its result records it. */
export type ToolCallStatus = 'ok' | 'error' | 'unknown';

const MESSAGE_ROLES: ReadonlySet<string> = new Set<MessageEvent['role']>([
  'user',
  'assistant',
  'system',
]);
const TOOL_CALL_STATUSES: ReadonlySet<string> = new Set<ToolCallStatus>(['ok', 'error', 'unknown']);

/** One tool call, yielded when its result is seen or, without a result, at the end of the file. */
export type ToolCallEvent = EventBase & {
  kind: 'tool_call';
  toolCallId?: string;
  name: string;
  /** `unknown`: no result in this file, or a status the source logs that is not recognised. */
  status: ToolCallStatus;
  /** The result record's timestamp, or the carried one when the record has none. */
  completedAt?: string;
  /** Only when the source logs a duration. */
  durationMs?: number;
  /** The assistant message that made the call. */
  messageId?: string;
};

/** The facts a `session_meta` event can carry. Each is set only when a record states it. */
export type SessionMetaFields = {
  cwd?: string;
  /** Only with `{ text: true }`: titles summarise content. */
  title?: string;
  gitBranch?: string;
  agentVersion?: string;
  parentSessionId?: string;
  model?: string;
  rawProvider?: string;
};

/** Facts about a session that changed at this record: any subset of `SessionMetaFields`. */
export type SessionMetaEvent = EventBase & { kind: 'session_meta' } & SessionMetaFields;

/** Any event `readEvents` yields; narrow on `kind`. */
export type SessionEvent = UsageRecord | MessageEvent | ToolCallEvent | SessionMetaEvent;

type EventBaseInput = {
  source: SourceId;
  sessionId: string;
  timestamp: string | Date;
  raw?: unknown;
};

/** What `createUsageRecord` takes: a `UsageEventInput` plus the logged provider and raw record. */
export type UsageRecordInput = UsageEventInput & {
  rawProvider?: string;
  raw?: unknown;
};

/** What `createMessageEvent` takes, before normalization. */
export type MessageEventInput = EventBaseInput & {
  role: MessageEvent['role'];
  messageId?: string;
  model?: string;
  textLength: NumberLike;
  text?: string;
};

/** What `createToolCallEvent` takes, before normalization. */
export type ToolCallEventInput = EventBaseInput & {
  toolCallId?: string;
  name: string;
  status: ToolCallStatus;
  completedAt?: string | Date;
  durationMs?: NumberLike;
  messageId?: string;
};

/** What `createSessionMetaEvent` takes, before normalization. */
export type SessionMetaEventInput = EventBaseInput & SessionMetaFields;

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = stripControlCharacters(value).trim();
  return normalized || undefined;
}

function requireText(value: string, kind: EventKind, fieldName: string): string {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    throw new Error(`${kind} event ${fieldName} must be a non-empty string`);
  }

  return normalized;
}

/** Rejects a value outside its union, such as a role read from an untrusted record. */
function requireOneOf<T extends string>(
  value: T,
  allowed: ReadonlySet<string>,
  kind: EventKind,
  fieldName: string,
): T {
  if (!allowed.has(value)) {
    throw new Error(`${kind} event ${fieldName} is not one of ${[...allowed].join(', ')}`);
  }

  return value;
}

function createEventBase(
  kind: Exclude<EventKind, 'usage'>,
  input: EventBaseInput,
): Omit<EventBase, 'raw'> {
  const source = normalizeSourceId(input.source);

  if (!source) {
    throw new Error(`${kind} event source must be a non-empty string`);
  }

  return {
    source,
    sessionId: requireText(input.sessionId, kind, 'sessionId'),
    timestamp: normalizeTimestamp(input.timestamp),
  };
}

/** Copies the defined values of `fields` onto `target`, so undefined keys stay absent. */
function assignDefined<T extends object>(target: T, fields: Record<string, unknown>): T {
  // `fields` is always an object literal, so `for...in` sees only its own keys, in order.
  for (const key in fields) {
    const value = fields[key];

    if (value !== undefined) {
      Reflect.set(target, key, value);
    }
  }

  return target;
}

/**
 * The session_meta fields normalized as `createSessionMetaEvent` stores them, with empty
 * values dropped. The session_meta change tracker compares these.
 */
export function normalizeSessionMetaFields(fields: SessionMetaFields): SessionMetaFields {
  return assignDefined<SessionMetaFields>(
    {},
    {
      cwd: normalizeOptionalText(fields.cwd),
      title: normalizeOptionalText(fields.title),
      gitBranch: normalizeOptionalText(fields.gitBranch),
      agentVersion: normalizeOptionalText(fields.agentVersion),
      parentSessionId: normalizeOptionalText(fields.parentSessionId),
      model: normalizeOptionalModel(fields.model),
      rawProvider: normalizeOptionalText(fields.rawProvider),
    },
  );
}

/** A usage event, ids included, then the raw provider and raw record when defined. */
export function createUsageRecord(input: UsageRecordInput): UsageRecord {
  return assignDefined<UsageRecord>(
    { kind: 'usage', ...createUsageEvent(input) },
    {
      rawProvider: normalizeOptionalText(input.rawProvider),
      raw: input.raw,
    },
  );
}

/**
 * Builds a normalized message event. Throws when the source or session id is empty, the
 * role is not `user`, `assistant` or `system`, or the timestamp is invalid. The text is kept
 * as logged; ids and model are trimmed, and empty ones are left out.
 */
export function createMessageEvent(input: MessageEventInput): MessageEvent {
  return assignDefined<MessageEvent>(
    {
      kind: 'message',
      ...createEventBase('message', input),
      role: requireOneOf(input.role, MESSAGE_ROLES, 'message', 'role'),
      textLength: normalizeNonNegativeInteger(input.textLength),
    },
    {
      messageId: normalizeOptionalText(input.messageId),
      model: normalizeOptionalModel(input.model),
      // Message text is kept as logged: no trimming, no control-character stripping.
      text: input.text,
      raw: input.raw,
    },
  );
}

/**
 * Builds a normalized tool call event. Throws when the source, session id or name is empty,
 * the status is not one of `ToolCallStatus`, or a timestamp is invalid.
 */
export function createToolCallEvent(input: ToolCallEventInput): ToolCallEvent {
  return assignDefined<ToolCallEvent>(
    {
      kind: 'tool_call',
      ...createEventBase('tool_call', input),
      name: requireText(input.name, 'tool_call', 'name'),
      status: requireOneOf(input.status, TOOL_CALL_STATUSES, 'tool_call', 'status'),
    },
    {
      toolCallId: normalizeOptionalText(input.toolCallId),
      completedAt:
        input.completedAt === undefined ? undefined : normalizeTimestamp(input.completedAt),
      durationMs:
        input.durationMs === undefined || input.durationMs === null
          ? undefined
          : normalizeNonNegativeInteger(input.durationMs),
      messageId: normalizeOptionalText(input.messageId),
      raw: input.raw,
    },
  );
}

/**
 * Builds a normalized session_meta event. Fields are trimmed, and empty ones are left out.
 * Throws when the source or session id is empty or the timestamp is invalid.
 */
export function createSessionMetaEvent(input: SessionMetaEventInput): SessionMetaEvent {
  return assignDefined<SessionMetaEvent>(
    {
      kind: 'session_meta',
      ...createEventBase('session_meta', input),
      ...normalizeSessionMetaFields(input),
    },
    { raw: input.raw },
  );
}

/** Narrows a `SessionEvent` to a usage record. */
export function isUsageRecord(event: SessionEvent): event is UsageRecord {
  return event.kind === 'usage';
}

/** A usage event: a plain `UsageEvent` (no `kind`) or a usage record. */
export function isUsageEvent<E extends UsageEvent | SessionEvent>(
  event: E,
): event is E & UsageEvent {
  return !('kind' in event) || event.kind === 'usage';
}
