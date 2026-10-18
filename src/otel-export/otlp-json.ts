import { createHash } from 'node:crypto';

import { SEMCONV_GENAI_REF, type OtelAttributes } from '@ayagmar/agent-sessions/otel';

/**
 * The OTLP/JSON pieces every signal shares: resource, scope, attribute values, timestamps
 * and ids. The encoding follows the OTLP "JSON Protobuf Encoding": hex ids, int64 values as
 * decimal strings, enums as integers, lowerCamelCase keys.
 */

export type OtlpAnyValue =
  { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };

export type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpResource = { attributes: OtlpKeyValue[] };

export type OtlpScope = { name: string; attributes: OtlpKeyValue[] };

// Attributes whose values are fractional in general: a whole number stays a double, so a
// backend sees one type per attribute.
const DOUBLE_ATTRIBUTES: ReadonlySet<string> = new Set(['llm_usage.cost_usd']);

// The agents' own `service.name` where it differs from our source id, so a backfill groups
// with the data the agent exports itself.
const SERVICE_NAMES = new Map<string, string>([['claude', 'claude-code']]);

/** The `service.name` and `gen_ai.agent.name` of a source's agent. */
export function toAgentName(source: string): string {
  return SERVICE_NAMES.get(source) ?? source;
}

function toAnyValue(key: string, value: string | number | boolean): OtlpAnyValue {
  if (typeof value === 'string') {
    return { stringValue: value };
  }

  if (typeof value === 'boolean') {
    return { boolValue: value };
  }

  return Number.isInteger(value) && !DOUBLE_ATTRIBUTES.has(key)
    ? { intValue: String(value) }
    : { doubleValue: value };
}

/** Attributes as OTLP key-values, in the order given. */
export function toOtlpAttributes(attributes: OtelAttributes): OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toAnyValue(key, value),
  }));
}

/** A resource per agent. */
export function createAgentResource(source: string): OtlpResource {
  return { attributes: toOtlpAttributes({ 'service.name': toAgentName(source) }) };
}

/** The instrumentation scope, naming the semconv-genai commit the attribute names follow. */
export const OTLP_SCOPE: OtlpScope = {
  name: 'llm-usage-metrics',
  attributes: toOtlpAttributes({ 'llm_usage.semconv_genai.commit': SEMCONV_GENAI_REF.commit }),
};

/** The schema URL for scope data whose attributes follow the pinned GenAI conventions. */
export const OTLP_SCHEMA_URL = SEMCONV_GENAI_REF.schemaUrl;

/** Milliseconds since the epoch as fixed64 nanoseconds, a decimal string past 2^53. */
export function toUnixNanos(epochMs: number): string {
  return (BigInt(epochMs) * 1_000_000n).toString();
}

function hashHex(parts: readonly string[], bytes: number): string {
  return createHash('sha256')
    .update(parts.join('\0'))
    .digest('hex')
    .slice(0, bytes * 2);
}

/** A 16-byte trace id from a session's source and id: the same session, the same id. */
export function deriveTraceId(source: string, sessionId: string): string {
  return hashHex(['llm-usage', source, sessionId], 16);
}

/** An 8-byte span id from its trace id, its kind and a key stable within that trace. */
export function deriveSpanId(traceId: string, kind: string, key: string): string {
  return hashHex([traceId, kind, key], 8);
}
