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

export type EventKind = 'usage' | 'message' | 'tool_call' | 'session_meta';

// Frozen: adapters share it as their declared kinds.
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

export type UsageRecord = EventBase & { kind: 'usage' } & Omit<UsageEvent, keyof EventBase> & {
    /** The provider's response or message id, as logged. */
    messageId?: string;
    /** The API request id, as logged. */
    requestId?: string;
    /** The provider as logged; undefined when the adapter inferred it. */
    rawProvider?: string;
  };

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

export type ToolCallStatus = 'ok' | 'error' | 'unknown';

const MESSAGE_ROLES: ReadonlySet<string> = new Set<MessageEvent['role']>([
  'user',
  'assistant',
  'system',
]);
const TOOL_CALL_STATUSES: ReadonlySet<string> = new Set<ToolCallStatus>(['ok', 'error', 'unknown']);

export type ToolCallEvent = EventBase & {
  kind: 'tool_call';
  toolCallId?: string;
  name: string;
  /** `unknown`: no result in this file, or a status the source logs that is not recognised. */
  status: ToolCallStatus;
  /** The result record's timestamp. */
  completedAt?: string;
  /** Only when the source logs a duration. */
  durationMs?: number;
  /** The assistant message that made the call. */
  messageId?: string;
};

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

export type SessionMetaEvent = EventBase & { kind: 'session_meta' } & SessionMetaFields;

export type SessionEvent = UsageRecord | MessageEvent | ToolCallEvent | SessionMetaEvent;

type EventBaseInput = {
  source: SourceId;
  sessionId: string;
  timestamp: string | Date;
  raw?: unknown;
};

export type UsageRecordInput = UsageEventInput & {
  messageId?: string;
  requestId?: string;
  rawProvider?: string;
  raw?: unknown;
};

export type MessageEventInput = EventBaseInput & {
  role: MessageEvent['role'];
  messageId?: string;
  model?: string;
  textLength: NumberLike;
  text?: string;
};

export type ToolCallEventInput = EventBaseInput & {
  toolCallId?: string;
  name: string;
  status: ToolCallStatus;
  completedAt?: string | Date;
  durationMs?: NumberLike;
  messageId?: string;
};

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
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      Object.assign(target, { [key]: value });
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

/** A usage event as `read` yields it, then the ids and raw provider when defined. */
export function createUsageRecord(input: UsageRecordInput): UsageRecord {
  return assignDefined<UsageRecord>(
    { kind: 'usage', ...createUsageEvent(input) },
    {
      messageId: normalizeOptionalText(input.messageId),
      requestId: normalizeOptionalText(input.requestId),
      rawProvider: normalizeOptionalText(input.rawProvider),
      raw: input.raw,
    },
  );
}

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

export function isUsageRecord(event: SessionEvent): event is UsageRecord {
  return event.kind === 'usage';
}

/** A usage event: a plain `UsageEvent` (no `kind`) or a usage record. */
export function isUsageEvent<E extends UsageEvent | SessionEvent>(
  event: E,
): event is E & UsageEvent {
  return !('kind' in event) || event.kind === 'usage';
}
