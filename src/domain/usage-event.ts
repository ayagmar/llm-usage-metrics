import {
  normalizeNonNegativeInteger,
  normalizeTimestamp,
  normalizeUsdCost,
  type NumberLike,
} from './normalization.js';
import { normalizeProviderToBillingEntity } from './provider-normalization.js';

export type SourceId = 'pi' | 'codex' | (string & {});

export type CostMode = 'explicit' | 'estimated';

export type UsageEvent = {
  source: SourceId;
  sessionId: string;
  timestamp: string;
  repoRoot?: string;
  provider?: string;
  model?: string;

  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;

  costUsd?: number;
  costMode: CostMode;
};

export type BillableTokenUsage = Pick<
  UsageEvent,
  'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cacheReadTokens' | 'cacheWriteTokens'
>;

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
  totalTokens?: NumberLike;

  costUsd?: NumberLike;
  costMode?: CostMode;
};

export function normalizeSourceId(value: unknown): SourceId | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function requireText(value: string, fieldName: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`UsageEvent ${fieldName} must be a non-empty string`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeOptionalProvider(value: string | undefined): string | undefined {
  return normalizeProviderToBillingEntity(value);
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  return normalizeOptionalText(value);
}

function normalizeOptionalModel(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);

  if (!normalized) {
    return undefined;
  }

  return normalized.toLowerCase();
}

function resolveCostMode(costMode: CostMode | undefined, costUsd: number | undefined): CostMode {
  if (costMode === 'explicit' && costUsd === undefined) {
    throw new Error('UsageEvent with costMode "explicit" requires costUsd');
  }

  if (costMode) {
    return costMode;
  }

  return costUsd === undefined ? 'estimated' : 'explicit';
}

export function createUsageEvent(input: UsageEventInput): UsageEvent {
  const source = normalizeSourceId(input.source);

  if (!source) {
    throw new Error('UsageEvent source must be a non-empty string');
  }

  const inputTokens = normalizeNonNegativeInteger(input.inputTokens);
  const outputTokens = normalizeNonNegativeInteger(input.outputTokens);
  const reasoningTokens = normalizeNonNegativeInteger(input.reasoningTokens);
  const cacheReadTokens = normalizeNonNegativeInteger(input.cacheReadTokens);
  const cacheWriteTokens = normalizeNonNegativeInteger(input.cacheWriteTokens);
  const declaredTotalTokens = normalizeNonNegativeInteger(input.totalTokens);
  const componentTotalTokens =
    inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = declaredTotalTokens > 0 ? declaredTotalTokens : componentTotalTokens;

  const costUsd = normalizeUsdCost(input.costUsd);
  const costMode = resolveCostMode(input.costMode, costUsd);

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
    totalTokens,
    costUsd,
    costMode,
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
