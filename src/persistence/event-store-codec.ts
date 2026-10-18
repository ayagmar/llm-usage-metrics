import {
  hasControlCharacters,
  normalizeProviderToBillingEntity,
} from '@ayagmar/agent-sessions/internal';
import { parseCanonicalTimestampMs } from '../utils/time-buckets.js';
import { createUsageEvent, type UsageEvent, type UsageEventInput } from '../domain/usage-event.js';
import { toNonNegativeInteger, toNonNegativeNumber, toText } from './event-store-database.js';

const FAST_PATH_REJECT = Symbol('fast path reject');

type OptionalStoredText = string | undefined | typeof FAST_PATH_REJECT;
type AcceptedTextSlot = { value: string | undefined };

// The rows of a file mostly repeat one session, model, provider and repo root. Each
// text column keeps the last value that passed its checks, which are pure functions of
// the value, and accepts an equal string without running them again.
const acceptedText: Record<
  'source' | 'sessionId' | 'repoRoot' | 'provider' | 'model',
  AcceptedTextSlot
> = {
  source: { value: undefined },
  sessionId: { value: undefined },
  repoRoot: { value: undefined },
  provider: { value: undefined },
  model: { value: undefined },
};

/** The columns of a `StoredEventTuple`, from `files` joined with `events`. */
export const STORED_EVENT_COLUMNS = [
  'files.source, events.session_id, events.timestamp, events.model, events.provider,',
  '  events.repo_root, events.input_tokens, events.output_tokens, events.reasoning_tokens,',
  '  events.cache_read_tokens, events.cache_write_tokens, events.cache_write_1h_tokens,',
  '  events.total_tokens, events.cost_usd, events.cost_mode',
].join('\n');

export type StoredEventTuple = [
  source: unknown,
  session_id: unknown,
  timestamp: unknown,
  model: unknown,
  provider: unknown,
  repo_root: unknown,
  input_tokens: unknown,
  output_tokens: unknown,
  reasoning_tokens: unknown,
  cache_read_tokens: unknown,
  cache_write_tokens: unknown,
  cache_write_1h_tokens: unknown,
  total_tokens: unknown,
  cost_usd: unknown,
  cost_mode: unknown,
];

export function normalizeStoredEvent(row: Record<string, unknown>): UsageEvent | undefined {
  return fastMaterializeStoredEvent(row) ?? slowNormalizeStoredEvent(row);
}

function slowNormalizeStoredEvent(row: Record<string, unknown>): UsageEvent | undefined {
  const costMode =
    row.cost_mode === 'explicit' || row.cost_mode === 'estimated' ? row.cost_mode : undefined;

  if (!costMode) {
    return undefined;
  }

  const input: UsageEventInput = {
    source: toText(row.source) ?? '',
    sessionId: toText(row.session_id) ?? '',
    timestamp: toText(row.timestamp) ?? '',
    repoRoot: toText(row.repo_root),
    provider: toText(row.provider),
    model: toText(row.model),
    inputTokens: toNonNegativeInteger(row.input_tokens),
    outputTokens: toNonNegativeInteger(row.output_tokens),
    reasoningTokens: toNonNegativeInteger(row.reasoning_tokens),
    cacheReadTokens: toNonNegativeInteger(row.cache_read_tokens),
    cacheWriteTokens: toNonNegativeInteger(row.cache_write_tokens),
    cacheWrite1hTokens: toNonNegativeInteger(row.cache_write_1h_tokens),
    totalTokens: toNonNegativeInteger(row.total_tokens),
    costUsd: toNonNegativeNumber(row.cost_usd),
    costMode,
  };

  try {
    return createUsageEvent(input);
  } catch {
    return undefined;
  }
}

function fastMaterializeStoredEvent(row: Record<string, unknown>): UsageEvent | undefined {
  return materializeStoredEvent(
    row.source,
    row.session_id,
    row.timestamp,
    row.model,
    row.provider,
    row.repo_root,
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.cache_write_1h_tokens,
    row.total_tokens,
    row.cost_usd,
    row.cost_mode,
  );
}

export function normalizeStoredEventTuple(row: StoredEventTuple): UsageEvent | undefined {
  const event = materializeStoredEvent(...row);

  if (event) {
    return event;
  }

  return slowNormalizeStoredEvent({
    source: row[0],
    session_id: row[1],
    timestamp: row[2],
    model: row[3],
    provider: row[4],
    repo_root: row[5],
    input_tokens: row[6],
    output_tokens: row[7],
    reasoning_tokens: row[8],
    cache_read_tokens: row[9],
    cache_write_tokens: row[10],
    cache_write_1h_tokens: row[11],
    total_tokens: row[12],
    cost_usd: row[13],
    cost_mode: row[14],
  });
}

function materializeStoredEvent(
  sourceValue: unknown,
  sessionIdValue: unknown,
  timestampValue: unknown,
  modelValue: unknown,
  providerValue: unknown,
  repoRootValue: unknown,
  inputTokensValue: unknown,
  outputTokensValue: unknown,
  reasoningTokensValue: unknown,
  cacheReadTokensValue: unknown,
  cacheWriteTokensValue: unknown,
  cacheWrite1hTokensValue: unknown,
  totalTokensValue: unknown,
  costUsdValue: unknown,
  costModeValue: unknown,
): UsageEvent | undefined {
  const costMode =
    costModeValue === 'explicit' || costModeValue === 'estimated' ? costModeValue : undefined;

  if (!costMode) {
    return undefined;
  }

  const source = toStoredRequiredText(sourceValue, acceptedText.source);
  const sessionId = toStoredRequiredText(sessionIdValue, acceptedText.sessionId);
  const timestamp = toStoredTimestamp(timestampValue);
  const repoRoot = toStoredOptionalText(repoRootValue, acceptedText.repoRoot);
  const provider = toStoredOptionalText(providerValue, acceptedText.provider, isBillingEntity);
  const model = toStoredOptionalText(modelValue, acceptedText.model, isLowerCase);
  const inputTokens = toStoredNonNegativeInteger(inputTokensValue);
  const outputTokens = toStoredNonNegativeInteger(outputTokensValue);
  const reasoningTokens = toStoredNonNegativeInteger(reasoningTokensValue);
  const cacheReadTokens = toStoredNonNegativeInteger(cacheReadTokensValue);
  const cacheWriteTokens = toStoredNonNegativeInteger(cacheWriteTokensValue);
  const cacheWrite1hTokens = toStoredNonNegativeInteger(cacheWrite1hTokensValue);
  const totalTokens = toStoredNonNegativeInteger(totalTokensValue);
  const costUsd = toStoredCostUsd(costUsdValue, costMode);

  if (
    !source ||
    !sessionId ||
    !timestamp ||
    repoRoot === FAST_PATH_REJECT ||
    provider === FAST_PATH_REJECT ||
    model === FAST_PATH_REJECT ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    cacheWrite1hTokens === undefined ||
    cacheWrite1hTokens > cacheWriteTokens ||
    totalTokens === undefined ||
    costUsd === FAST_PATH_REJECT
  ) {
    return undefined;
  }

  return {
    source,
    sessionId,
    timestamp,
    repoRoot,
    provider,
    model,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
    totalTokens,
    costUsd,
    costMode,
  };
}

function isBillingEntity(provider: string): boolean {
  return normalizeProviderToBillingEntity(provider) === provider;
}

function isLowerCase(model: string): boolean {
  return model === model.toLowerCase();
}

function toStoredRequiredText(
  value: unknown,
  slot: AcceptedTextSlot,
  isCanonical?: (value: string) => boolean,
): string | undefined {
  // Only an accepted string is ever stored, so a match is a string that passes.
  if (value === slot.value) {
    return slot.value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  if (value !== value.trim() || hasControlCharacters(value)) {
    return undefined;
  }

  if (isCanonical && !isCanonical(value)) {
    return undefined;
  }

  slot.value = value;
  return value;
}

function toStoredOptionalText(
  value: unknown,
  slot: AcceptedTextSlot,
  isCanonical?: (value: string) => boolean,
): OptionalStoredText {
  if (value === null) {
    return undefined;
  }

  return toStoredRequiredText(value, slot, isCanonical) ?? FAST_PATH_REJECT;
}

// A year below 100 fails the canonical reader and takes the slow path, which keeps it.
function toStoredTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && parseCanonicalTimestampMs(value) !== undefined
    ? value
    : undefined;
}

function toStoredNonNegativeInteger(value: unknown): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return undefined;
  }

  return value;
}

function toStoredCostUsd(
  value: unknown,
  costMode: 'explicit' | 'estimated',
): number | undefined | typeof FAST_PATH_REJECT {
  if (value === null) {
    return costMode === 'explicit' ? FAST_PATH_REJECT : undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return FAST_PATH_REJECT;
  }

  return value;
}
