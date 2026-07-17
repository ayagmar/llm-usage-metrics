import { createUsageEvent, type UsageEvent } from '../../domain/usage-event.js';
import { asTrimmedText } from '../parsing-utils.js';
import {
  getFirstProtoLengthDelimitedField,
  getFirstProtoStringField,
  getFirstProtoVarintField,
  readAntigravityProtoFields,
} from './antigravity-proto-reader.js';

const GEN_METADATA_CHAT_MODEL_FIELD = 1;
const CHAT_MODEL_USAGE_FIELD = 4;
const CHAT_MODEL_TIMESTAMP_WRAPPER_FIELD = 9;
const CHAT_MODEL_RESPONSE_MODEL_FIELD = 19;
const USAGE_FIXED_INPUT_FIELD = 1;
const USAGE_NEW_INPUT_FIELD = 2;
const USAGE_CACHE_READ_FIELD = 5;
const USAGE_OUTPUT_FIELD = 9;
const USAGE_REASONING_FIELD = 10;
const USAGE_RESPONSE_ID_FIELD = 11;
const TRAJECTORY_CREATED_AT_FIELD = 2;
const TIMESTAMP_WRAPPER_TIMESTAMP_FIELD = 4;
const TIMESTAMP_SECONDS_FIELD = 1;
const TIMESTAMP_NANOS_FIELD = 2;
const MILLISECONDS_PER_SECOND = 1_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export type AntigravitySkippedRowReason =
  'invalid_payload' | 'invalid_timestamp' | 'no_token_usage';

export type AntigravityParsedRow = {
  event?: UsageEvent;
  responseId?: string;
  skippedReason?: AntigravitySkippedRowReason;
};

type AntigravityUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  responseId?: string;
};

function toBinaryData(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

function readFieldsFromBytes(bytes: Uint8Array) {
  return readAntigravityProtoFields(bytes);
}

function readTimestampFromBytes(timestampBytes: Uint8Array): string | undefined {
  const fields = readFieldsFromBytes(timestampBytes);
  const seconds = getFirstProtoVarintField(fields, TIMESTAMP_SECONDS_FIELD);

  if (seconds === undefined) {
    return undefined;
  }

  const nanos = getFirstProtoVarintField(fields, TIMESTAMP_NANOS_FIELD) ?? 0;
  const milliseconds = seconds * MILLISECONDS_PER_SECOND;

  if (!Number.isSafeInteger(milliseconds)) {
    return undefined;
  }

  const timestampMilliseconds = milliseconds + Math.floor(nanos / NANOSECONDS_PER_MILLISECOND);
  const date = new Date(timestampMilliseconds);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function readTurnTimestamp(chatFields: ReturnType<typeof readFieldsFromBytes>): string | undefined {
  const timestampWrapperBytes = getFirstProtoLengthDelimitedField(
    chatFields,
    CHAT_MODEL_TIMESTAMP_WRAPPER_FIELD,
  );

  if (!timestampWrapperBytes) {
    return undefined;
  }

  const timestampWrapperFields = readFieldsFromBytes(timestampWrapperBytes);
  const timestampBytes = getFirstProtoLengthDelimitedField(
    timestampWrapperFields,
    TIMESTAMP_WRAPPER_TIMESTAMP_FIELD,
  );

  return timestampBytes ? readTimestampFromBytes(timestampBytes) : undefined;
}

function readUsage(usageBytes: Uint8Array | undefined): AntigravityUsage | undefined {
  if (!usageBytes) {
    return undefined;
  }

  const fields = readFieldsFromBytes(usageBytes);
  const fixedInputTokens = getFirstProtoVarintField(fields, USAGE_FIXED_INPUT_FIELD) ?? 0;
  const newInputTokens = getFirstProtoVarintField(fields, USAGE_NEW_INPUT_FIELD) ?? 0;
  const outputTokens = getFirstProtoVarintField(fields, USAGE_OUTPUT_FIELD) ?? 0;
  const reasoningTokens = getFirstProtoVarintField(fields, USAGE_REASONING_FIELD) ?? 0;
  const cacheReadTokens = getFirstProtoVarintField(fields, USAGE_CACHE_READ_FIELD) ?? 0;

  return {
    inputTokens: fixedInputTokens + newInputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    responseId: asTrimmedText(getFirstProtoStringField(fields, USAGE_RESPONSE_ID_FIELD)),
  };
}

function hasUsageSignal(usage: AntigravityUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.cacheReadTokens > 0
  );
}

export function parseAntigravitySessionCreatedAt(value: unknown): string | undefined {
  const bytes = toBinaryData(value);

  if (!bytes) {
    return undefined;
  }

  try {
    const fields = readFieldsFromBytes(bytes);
    const timestampBytes = getFirstProtoLengthDelimitedField(fields, TRAJECTORY_CREATED_AT_FIELD);

    return timestampBytes ? readTimestampFromBytes(timestampBytes) : undefined;
  } catch {
    return undefined;
  }
}

export function parseAntigravityMetadataBlob(
  value: unknown,
  options: {
    sessionId: string;
    fallbackTimestamp: string | undefined;
    seenResponseIds: Set<string>;
  },
): AntigravityParsedRow {
  const bytes = toBinaryData(value);

  if (!bytes) {
    return { skippedReason: 'invalid_payload' };
  }

  try {
    const topLevelFields = readFieldsFromBytes(bytes);
    const chatModelBytes = getFirstProtoLengthDelimitedField(
      topLevelFields,
      GEN_METADATA_CHAT_MODEL_FIELD,
    );

    if (!chatModelBytes) {
      return { skippedReason: 'invalid_payload' };
    }

    const chatFields = readFieldsFromBytes(chatModelBytes);
    const usage = readUsage(getFirstProtoLengthDelimitedField(chatFields, CHAT_MODEL_USAGE_FIELD));

    if (!usage || !hasUsageSignal(usage)) {
      return { skippedReason: 'no_token_usage' };
    }

    if (usage.responseId && options.seenResponseIds.has(usage.responseId)) {
      return { responseId: usage.responseId };
    }

    const timestamp = readTurnTimestamp(chatFields) ?? options.fallbackTimestamp;

    if (!timestamp) {
      return {
        responseId: usage.responseId,
        skippedReason: 'invalid_timestamp',
      };
    }

    return {
      responseId: usage.responseId,
      event: createUsageEvent({
        source: 'antigravity',
        sessionId: options.sessionId,
        timestamp,
        model: getFirstProtoStringField(chatFields, CHAT_MODEL_RESPONSE_MODEL_FIELD),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: 0,
        costMode: 'estimated',
      }),
    };
  } catch {
    return { skippedReason: 'invalid_payload' };
  }
}
