import { createHash } from 'node:crypto';

import { normalizeProviderToBillingEntity } from '../domain/provider-normalization.js';
import { createUsageEvent, type UsageEvent, type UsageEventInput } from '../domain/usage-event.js';
import { toNonNegativeInteger, toNonNegativeNumber, toText } from './event-store-database.js';

const CONTROL_CHARACTERS_PATTERN = new RegExp(String.raw`[\u0000-\u001F\u007F-\u009F]`, 'u');
const NORMALIZED_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const FAST_PATH_REJECT = Symbol('fast path reject');

type OptionalStoredText = string | undefined | typeof FAST_PATH_REJECT;

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
    total_tokens: row[11],
    cost_usd: row[12],
    cost_mode: row[13],
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
  totalTokensValue: unknown,
  costUsdValue: unknown,
  costModeValue: unknown,
): UsageEvent | undefined {
  const costMode =
    costModeValue === 'explicit' || costModeValue === 'estimated' ? costModeValue : undefined;

  if (!costMode) {
    return undefined;
  }

  const source = toStoredRequiredText(sourceValue);
  const sessionId = toStoredRequiredText(sessionIdValue);
  const timestamp = toStoredTimestamp(timestampValue);
  const repoRoot = toStoredOptionalText(repoRootValue);
  const provider = toStoredOptionalText(providerValue);
  const model = toStoredOptionalText(modelValue);
  const inputTokens = toStoredNonNegativeInteger(inputTokensValue);
  const outputTokens = toStoredNonNegativeInteger(outputTokensValue);
  const reasoningTokens = toStoredNonNegativeInteger(reasoningTokensValue);
  const cacheReadTokens = toStoredNonNegativeInteger(cacheReadTokensValue);
  const cacheWriteTokens = toStoredNonNegativeInteger(cacheWriteTokensValue);
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
    totalTokens === undefined ||
    costUsd === FAST_PATH_REJECT
  ) {
    return undefined;
  }

  if (provider && normalizeProviderToBillingEntity(provider) !== provider) {
    return undefined;
  }

  if (model && model !== model.toLowerCase()) {
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
    totalTokens,
    costUsd,
    costMode,
  };
}

function toStoredRequiredText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  if (value !== value.trim() || CONTROL_CHARACTERS_PATTERN.test(value)) {
    return undefined;
  }

  return value;
}

function toStoredOptionalText(value: unknown): OptionalStoredText {
  if (value === null) {
    return undefined;
  }

  return toStoredRequiredText(value) ?? FAST_PATH_REJECT;
}

function toStoredTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !NORMALIZED_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }

  if (!isValidNormalizedTimestamp(value)) {
    return undefined;
  }

  return value;
}

function isValidNormalizedTimestamp(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));

  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= maxDay;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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

export function computeEventContentHash(event: UsageEvent): string {
  const fields = [
    event.source.toLowerCase(),
    event.sessionId,
    event.timestamp,
    event.model ?? '',
    event.provider ?? '',
    event.repoRoot ?? '',
    event.inputTokens,
    event.outputTokens,
    event.reasoningTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.totalTokens,
    event.costMode,
    event.costUsd ?? '',
  ];

  return createHash('sha256').update(fields.map(String).join('\x1f')).digest('hex').slice(0, 16);
}
