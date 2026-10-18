import { getEventSessionKey, type ToolCallEvent } from '@ayagmar/agent-sessions';
import {
  toolCallAttributes,
  usageRecordAttributes,
  type OtelAttributes,
} from '@ayagmar/agent-sessions/otel';

import type { UsageEvent } from '../domain/usage-event.js';
import {
  createAgentResource,
  deriveSpanId,
  deriveTraceId,
  OTLP_SCHEMA_URL,
  OTLP_SCOPE,
  toAgentName,
  toOtlpAttributes,
  toUnixNanos,
  type OtlpKeyValue,
  type OtlpResource,
  type OtlpScope,
} from './otlp-json.js';

/** OTLP `Span.SpanKind`. */
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
/** OTLP `Status.StatusCode`. */
const STATUS_CODE_ERROR = 2;

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: { code: number };
};

/** One OTLP `TracesData`: one session's spans under its agent's resource. */
export type OtlpTracesData = {
  resourceSpans: [
    {
      resource: OtlpResource;
      scopeSpans: [{ scope: OtlpScope; spans: OtlpSpan[]; schemaUrl: string }];
    },
  ];
};

export type OtlpTracesInput = {
  /** In export order: the first event of a session places its trace. */
  usageEvents: readonly UsageEvent[];
  /** The sessions' tool calls, deduplicated; calls of sessions without usage are left out. */
  toolCalls: readonly ToolCallEvent[];
  /** Emit `llm_usage.repo_root`. */
  includePaths?: boolean;
};

type SessionGroup = {
  source: string;
  sessionId: string;
  usageEvents: UsageEvent[];
  toolCalls: ToolCallEvent[];
};

type TimedSpan = { span: OtlpSpan; startMs: number; endMs: number };

function groupSessions(input: OtlpTracesInput): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();

  for (const event of input.usageEvents) {
    const key = getEventSessionKey(event);
    const group = groups.get(key);

    if (group) {
      group.usageEvents.push(event);
    } else {
      groups.set(key, {
        source: event.source,
        sessionId: event.sessionId,
        usageEvents: [event],
        toolCalls: [],
      });
    }
  }

  for (const call of input.toolCalls) {
    groups.get(getEventSessionKey(call))?.toolCalls.push(call);
  }

  return [...groups.values()];
}

function sortByTimestamp(calls: readonly ToolCallEvent[]): ToolCallEvent[] {
  return calls
    .map((call, index) => ({ call, index, at: Date.parse(call.timestamp) }))
    .sort((left, right) => left.at - right.at || left.index - right.index)
    .map(({ call }) => call);
}

function chatSpan(
  event: UsageEvent,
  ordinal: number,
  traceId: string,
  parentSpanId: string,
  includePaths: boolean,
): TimedSpan & { attributes: OtelAttributes } {
  const at = Date.parse(event.timestamp);
  const attributes = usageRecordAttributes({ ...event, kind: 'usage' }, { includePaths });

  if (event.machine !== undefined) {
    attributes['llm_usage.machine'] = event.machine;
  }

  return {
    attributes,
    startMs: at,
    endMs: at,
    span: {
      traceId,
      spanId: deriveSpanId(traceId, 'chat', `#${ordinal}`),
      parentSpanId,
      name: event.model === undefined ? 'chat' : `chat ${event.model}`,
      kind: SPAN_KIND_CLIENT,
      startTimeUnixNano: toUnixNanos(at),
      endTimeUnixNano: toUnixNanos(at),
      attributes: toOtlpAttributes(attributes),
    },
  };
}

function toolEndMs(call: ToolCallEvent, startMs: number): number {
  const endMs =
    call.completedAt === undefined
      ? startMs + (call.durationMs ?? 0)
      : Date.parse(call.completedAt);

  // A result logged before its call (clock changes between records) ends at the start.
  return Math.max(startMs, endMs);
}

function toolSpan(
  call: ToolCallEvent,
  ordinal: number,
  traceId: string,
  parentSpanId: string,
): TimedSpan {
  const startMs = Date.parse(call.timestamp);
  const endMs = toolEndMs(call, startMs);
  const key = call.toolCallId === undefined ? `#${ordinal}` : `id:${call.toolCallId}`;

  return {
    startMs,
    endMs,
    span: {
      traceId,
      spanId: deriveSpanId(traceId, 'execute_tool', key),
      parentSpanId,
      name: `execute_tool ${call.name}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNanos(startMs),
      endTimeUnixNano: toUnixNanos(endMs),
      attributes: toOtlpAttributes(toolCallAttributes(call)),
      ...(call.status === 'error' ? { status: { code: STATUS_CODE_ERROR } } : {}),
    },
  };
}

function sumAttribute(spans: readonly { attributes: OtelAttributes }[], key: string): number {
  return spans.reduce((total, span) => total + Number(span.attributes[key] ?? 0), 0);
}

function sessionTraces(group: SessionGroup, includePaths: boolean): OtlpTracesData {
  const traceId = deriveTraceId(group.source, group.sessionId);
  const rootSpanId = deriveSpanId(traceId, 'invoke_agent', '');
  const chats = group.usageEvents.map((event, ordinal) =>
    chatSpan(event, ordinal, traceId, rootSpanId, includePaths),
  );
  const tools = sortByTimestamp(group.toolCalls).map((call, ordinal) =>
    toolSpan(call, ordinal, traceId, rootSpanId),
  );
  const children = [...chats, ...tools];
  // A loop, not Math.min(...spread): a long session has more spans than call arguments allow.
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const child of children) {
    startMs = Math.min(startMs, child.startMs);
    endMs = Math.max(endMs, child.endMs);
  }
  const agentName = toAgentName(group.source);
  const root: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: `invoke_agent ${agentName}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNanos(startMs),
    endTimeUnixNano: toUnixNanos(endMs),
    attributes: toOtlpAttributes({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agentName,
      'gen_ai.conversation.id': group.sessionId,
      // Session sums of the chat spans' values; no cache attributes on this span (#469).
      'gen_ai.usage.input_tokens': sumAttribute(chats, 'gen_ai.usage.input_tokens'),
      'gen_ai.usage.output_tokens': sumAttribute(chats, 'gen_ai.usage.output_tokens'),
      'llm_usage.source': group.source,
    }),
  };

  return {
    resourceSpans: [
      {
        resource: createAgentResource(group.source),
        scopeSpans: [
          {
            scope: OTLP_SCOPE,
            spans: [root, ...children.map((child) => child.span)],
            schemaUrl: OTLP_SCHEMA_URL,
          },
        ],
      },
    ],
  };
}

/**
 * One `TracesData` per session, in the order of each session's first usage event: an
 * `invoke_agent {agent}` root from the session's earliest to its latest event, a zero-length
 * `chat {model}` child per usage event and an `execute_tool {name}` child per tool call.
 * Ids derive from the session and each span's stable key, so the same input gives the same
 * bytes.
 */
export function buildOtlpTraces(input: OtlpTracesInput): OtlpTracesData[] {
  return groupSessions(input).map((group) => sessionTraces(group, input.includePaths ?? false));
}
