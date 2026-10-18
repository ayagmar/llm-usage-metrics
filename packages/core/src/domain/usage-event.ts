import {
  normalizeNonNegativeInteger,
  normalizeTimestamp,
  normalizeUsdCost,
  stripControlCharacters,
  type NumberLike,
} from './normalization.js';
import { normalizeProviderToBillingEntity } from './provider-normalization.js';

/** A source adapter id such as `codex` or `claude`; any string an adapter declares. */
export type SourceId = string;

/**
 * Bump whenever `createUsageEvent` or other shared normalization changes the events
 * produced from unchanged source files. Like adapter parser versions, it is part of
 * the event-store cache key so stored events are re-parsed after the change.
 */
export const USAGE_EVENT_NORMALIZATION_VERSION = 3;

/**
 * How a consumer marks an event's cost: `explicit` when the source logged `costUsd`,
 * `estimated` when it is priced from tokens. Events leave adapters without one; the
 * content hash takes it as input.
 */
export type CostMode = 'explicit' | 'estimated';

/**
 * One normalized usage event: the tokens of one model response, as `read` yields it. Token
 * counts are non-negative integers.
 */
export type UsageEvent = {
  source: SourceId;
  sessionId: string;
  /** ISO 8601 in UTC. */
  timestamp: string;
  repoRoot?: string;
  /** The billing provider, normalized (`anthropic`, `openai`, `google` and so on). */
  provider?: string;
  /** Lowercased and trimmed. */
  model?: string;

  /** Fresh input: excludes cache reads and writes. */
  inputTokens: number;
  /** Includes reasoning; `reasoningTokens` is a breakdown of it. */
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` cached for one hour, billed at a higher rate. */
  cacheWrite1hTokens: number;
  /** The total the source logged, or the sum of the token fields when it logged none. */
  totalTokens: number;

  /** The cost the source recorded, in USD. Undefined when it recorded none. */
  costUsd?: number;
};

export type BillableTokenUsage = Pick<
  UsageEvent,
  'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;

/**
 * What `createUsageEvent` takes, before normalization. Missing or non-finite counts become 0.
 * Pass `totalTokens` when `reasoningTokens` is part of `outputTokens`, since the computed
 * total adds it again.
 */
export type UsageEventInput = {
  source: SourceId;
  sessionId: string;
  timestamp: string | Date;
  repoRoot?: string;
  provider?: string;
  model?: string;

  inputTokens?: NumberLike;
  outputTokens?: NumberLike;
  reasoningTokens?: NumberLike;
  cacheReadTokens?: NumberLike;
  cacheWriteTokens?: NumberLike;
  cacheWrite1hTokens?: NumberLike;
  totalTokens?: NumberLike;

  costUsd?: NumberLike;
};

/** A trimmed source id with control characters removed, or undefined when empty or not a string. */
export function normalizeSourceId(value: unknown): SourceId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = stripControlCharacters(value).trim();
  return normalized || undefined;
}

function requireText(value: string, fieldName: string): string {
  const normalized = stripControlCharacters(value).trim();

  if (!normalized) {
    throw new Error(`UsageEvent ${fieldName} must be a non-empty string`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = stripControlCharacters(value).trim();
  return normalized || undefined;
}

function normalizeOptionalProvider(value: string | undefined): string | undefined {
  return normalizeProviderToBillingEntity(normalizeOptionalText(value));
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  return normalizeOptionalText(value);
}

const MODEL_KEY_MAX_LENGTH = 256;

function normalizeModelKey(value: string): string {
  return stripControlCharacters(value).trim().toLowerCase().slice(0, MODEL_KEY_MAX_LENGTH);
}

export function normalizeOptionalModel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeModelKey(value);
  return normalized || undefined;
}

/** A key that identifies a session across sources: `source` and `sessionId` joined by a NUL. */
export function getEventSessionKey(event: Pick<UsageEvent, 'source' | 'sessionId'>): string {
  return `${event.source}\0${event.sessionId}`;
}

/** No model response logs this many tokens; a larger count is corrupt and would swamp totals. */
const MAX_TOKEN_COUNT = 1e12;

function normalizeTokenCount(value: NumberLike, fieldName: string): number {
  const count = normalizeNonNegativeInteger(value);

  if (count > MAX_TOKEN_COUNT) {
    throw new Error(`UsageEvent ${fieldName} exceeds ${String(MAX_TOKEN_COUNT)}`);
  }

  return count;
}

/**
 * Builds a normalized usage event. Throws when the source or session id is empty, the
 * timestamp is invalid or a token count exceeds 1e12. Counts are truncated to non-negative
 * integers, `cacheWrite1hTokens` is capped at `cacheWriteTokens`, the provider is normalized
 * to its billing entity and the model is lowercased.
 */
export function createUsageEvent(input: UsageEventInput): UsageEvent {
  const source = normalizeSourceId(input.source);

  if (!source) {
    throw new Error('UsageEvent source must be a non-empty string');
  }

  const inputTokens = normalizeTokenCount(input.inputTokens, 'inputTokens');
  const outputTokens = normalizeTokenCount(input.outputTokens, 'outputTokens');
  const reasoningTokens = normalizeTokenCount(input.reasoningTokens, 'reasoningTokens');
  const cacheReadTokens = normalizeTokenCount(input.cacheReadTokens, 'cacheReadTokens');
  const cacheWriteTokens = normalizeTokenCount(input.cacheWriteTokens, 'cacheWriteTokens');
  const cacheWrite1hTokens = Math.min(
    cacheWriteTokens,
    normalizeNonNegativeInteger(input.cacheWrite1hTokens),
  );
  const declaredTotalTokens = normalizeTokenCount(input.totalTokens, 'totalTokens');
  const componentTotalTokens =
    inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = input.totalTokens === undefined ? componentTotalTokens : declaredTotalTokens;

  const costUsd = normalizeUsdCost(input.costUsd);

  return {
    source,
    sessionId: requireText(input.sessionId, 'sessionId'),
    timestamp: normalizeTimestamp(input.timestamp),
    repoRoot: normalizeOptionalPath(input.repoRoot),
    provider: normalizeOptionalProvider(input.provider),
    model: normalizeOptionalModel(input.model),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
    totalTokens,
    costUsd,
  };
}

export function hasBillableTokenBuckets(usage: BillableTokenUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.reasoningTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheWriteTokens > 0
  );
}

export function isPriceableEvent(event: UsageEvent): boolean {
  return hasBillableTokenBuckets(event);
}
