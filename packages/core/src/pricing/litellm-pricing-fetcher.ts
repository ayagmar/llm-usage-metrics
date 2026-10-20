import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { asRecord } from '../utils/as-record.js';
import { ensureDirectory, readRegularTextFile, writeFileAtomic } from '../utils/fs-helpers.js';
import {
  explainCanonicalModelKey,
  normalizeKey,
  resolveCanonicalModelKey,
} from './litellm-model-matching.js';
import litellmPricingSnapshotPayload from './litellm-pricing-snapshot.json' with { type: 'json' };
import litellmRetiredPricingPayload from './litellm-retired-pricing.json' with { type: 'json' };
import litellmContextLimitsPayload from './litellm-context-limits.json' with { type: 'json' };
import type {
  ModelPricing,
  ModelPricingExplanation,
  PricingDataOrigin,
  PriorityFallbackBucket,
  PricingSource,
  PricingTier,
} from './types.js';

const ONE_MILLION = 1_000_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;
const DEFAULT_FETCH_RETRY_COUNT = 2;
const DEFAULT_FETCH_RETRY_DELAY_MS = 200;
export const MAX_LITELLM_PRICING_RESPONSE_BYTES = 33_554_432;

export const DEFAULT_LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Bumped when a cached model's pricing gains a rate. A default-source cache an older version
// wrote lacks it, so it is refetched, and the bundled snapshot replaces it when the fetch
// fails or pricing is offline. A custom-URL cache has no snapshot to fall back on, so it
// still serves as stale pricing.
const CACHE_FORMAT_VERSION = 3;

export type LiteLLMCachePayload = {
  fetchedAt: number;
  sourceUrl: string;
  pricingByModel: Record<string, ModelPricing>;
  /**
   * LiteLLM's `max_input_tokens` per priced key, as written; read entry by entry through
   * `readContextLimit`. Caches written before the limits were kept lack it.
   */
  maxInputTokensByModel?: Record<string, unknown>;
};

export type LiteLLMPricingLoadOrigin = 'cache' | 'network' | 'bundled-snapshot';

export type LiteLLMPricingFetcherOptions = {
  sourceUrl?: string;
  /** Where fetched prices are cached; read before fetching and written after. */
  cacheFilePath: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  fetchRetryCount?: number;
  fetchRetryDelayMs?: number;
  maxResponseBytes?: number;
  offline?: boolean;
  /** The only way the fetcher reaches the network. */
  fetchImpl: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

class RetryableLiteLLMFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RetryableLiteLLMFetchError';
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableFetchFailure(error: unknown): boolean {
  if (error instanceof RetryableLiteLLMFetchError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return /timeout|timed out|network|econn|enotfound|eai_again/iu.test(error.message);
}

let bundledLiteLLMPricingSnapshot: LiteLLMCachePayload | undefined;

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }

    return value;
  }

  if (typeof value === 'string') {
    if (value.trim() === '') {
      return undefined;
    }

    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      return undefined;
    }

    return parsedValue;
  }

  return undefined;
}

type TierRateField = Exclude<keyof PricingTier, 'aboveTokens'>;

// LiteLLM's standard long-context keys. Suffixed variants (`_batches`, `_priority`, `_flex`,
// ...) price other service tiers, and the anchors keep them out.
const TIER_RATE_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, TierRateField]> = [
  [/^input_cost_per_token_above_(\d+)k_tokens$/u, 'inputPer1MUsd'],
  [/^output_cost_per_token_above_(\d+)k_tokens$/u, 'outputPer1MUsd'],
  [/^cache_read_input_token_cost_above_(\d+)k_tokens$/u, 'cacheReadPer1MUsd'],
  [/^cache_creation_input_token_cost_above_(\d+)k_tokens$/u, 'cacheWritePer1MUsd'],
  [/^cache_creation_input_token_cost_above_1hr_above_(\d+)k_tokens$/u, 'cacheWrite1hPer1MUsd'],
];

function readTierRateKey(key: string): { field: TierRateField; aboveTokens: number } | undefined {
  if (!key.endsWith('k_tokens')) {
    return undefined;
  }

  for (const [pattern, field] of TIER_RATE_KEY_PATTERNS) {
    const match = pattern.exec(key);
    const aboveTokens = match ? Number(match[1]) * 1000 : Number.NaN;

    if (Number.isSafeInteger(aboveTokens)) {
      return { field, aboveTokens };
    }
  }

  return undefined;
}

/** Whether a LiteLLM key is one of the long-context rates the tiers carry. */
export function isLiteLLMTierRateKey(key: string): boolean {
  return readTierRateKey(key) !== undefined;
}

function sortTiersDescending(tiersByThreshold: Map<number, PricingTier>): PricingTier[] {
  return [...tiersByThreshold.values()].sort((left, right) => right.aboveTokens - left.aboveTokens);
}

function normalizeModelTiers(rawModelPricing: Record<string, unknown>): PricingTier[] | undefined {
  const tiersByThreshold = new Map<number, PricingTier>();

  for (const [key, value] of Object.entries(rawModelPricing)) {
    const tierRateKey = readTierRateKey(key);
    const perToken = tierRateKey ? toNonNegativeNumber(value) : undefined;

    if (!tierRateKey || perToken === undefined) {
      continue;
    }

    const tier = tiersByThreshold.get(tierRateKey.aboveTokens) ?? {
      aboveTokens: tierRateKey.aboveTokens,
    };
    tier[tierRateKey.field] = perToken * ONE_MILLION;
    tiersByThreshold.set(tierRateKey.aboveTokens, tier);
  }

  return tiersByThreshold.size === 0 ? undefined : sortTiersDescending(tiersByThreshold);
}

type RateWithOrigin = { perToken: number; priority: boolean };

/** A standard rate, or the priority rate when LiteLLM lists only that one. */
function readStandardOrPriorityRate(
  rawModelPricing: Record<string, unknown>,
  key: string,
): RateWithOrigin | undefined {
  const standard = toNonNegativeNumber(rawModelPricing[key]);

  if (standard !== undefined) {
    return { perToken: standard, priority: false };
  }

  const priority = toNonNegativeNumber(rawModelPricing[`${key}_priority`]);
  return priority === undefined ? undefined : { perToken: priority, priority: true };
}

function normalizeModelPricing(rawModelPricing: Record<string, unknown>): ModelPricing | undefined {
  const input = readStandardOrPriorityRate(rawModelPricing, 'input_cost_per_token');
  const output = readStandardOrPriorityRate(rawModelPricing, 'output_cost_per_token');

  if (input === undefined || output === undefined) {
    return undefined;
  }

  const cacheRead = readStandardOrPriorityRate(rawModelPricing, 'cache_read_input_token_cost');
  const cacheWrite = readStandardOrPriorityRate(rawModelPricing, 'cache_creation_input_token_cost');
  const cacheWrite1hPerToken = toNonNegativeNumber(
    rawModelPricing.cache_creation_input_token_cost_above_1hr,
  );
  const reasoningPerToken = toNonNegativeNumber(rawModelPricing.output_cost_per_reasoning_token);

  const modelPricing: ModelPricing = {
    inputPer1MUsd: input.perToken * ONE_MILLION,
    outputPer1MUsd: output.perToken * ONE_MILLION,
  };

  if (cacheRead !== undefined) {
    modelPricing.cacheReadPer1MUsd = cacheRead.perToken * ONE_MILLION;
  }

  if (cacheWrite !== undefined) {
    modelPricing.cacheWritePer1MUsd = cacheWrite.perToken * ONE_MILLION;
  }

  if (cacheWrite1hPerToken !== undefined) {
    modelPricing.cacheWrite1hPer1MUsd = cacheWrite1hPerToken * ONE_MILLION;
  }

  if (reasoningPerToken !== undefined) {
    modelPricing.reasoningPer1MUsd = reasoningPerToken * ONE_MILLION;
    modelPricing.reasoningBilling = 'separate';
  }

  const priorityFallback = (
    [
      ['input', input],
      ['output', output],
      ['cacheRead', cacheRead],
      ['cacheWrite', cacheWrite],
    ] as const
  )
    .filter(([, rate]) => rate?.priority)
    .map(([bucket]) => bucket);

  if (priorityFallback.length > 0) {
    modelPricing.priorityFallback = priorityFallback;
  }

  const tiers = normalizeModelTiers(rawModelPricing);

  if (tiers) {
    modelPricing.tiers = tiers;
  }

  return modelPricing;
}

export function normalizeLitellmPricingPayload(payload: unknown): Map<string, ModelPricing> {
  const payloadRecord = asRecord(payload);

  if (!payloadRecord) {
    throw new Error('LiteLLM pricing payload must be a JSON object');
  }

  const normalizedPricing = new Map<string, ModelPricing>();

  for (const [modelName, rawModelPricing] of Object.entries(payloadRecord)) {
    const modelPricingRecord = asRecord(rawModelPricing);

    if (!modelPricingRecord) {
      continue;
    }

    const normalizedModelPricing = normalizeModelPricing(modelPricingRecord);

    if (!normalizedModelPricing) {
      continue;
    }

    normalizedPricing.set(normalizeKey(modelName), normalizedModelPricing);
  }

  if (normalizedPricing.size === 0) {
    throw new Error('LiteLLM pricing payload did not contain any usable model pricing entries');
  }

  return normalizedPricing;
}

/** `max_input_tokens` for each key of `pricingByModel` that lists a positive one. */
export function normalizeLitellmContextLimits(
  payload: unknown,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): Map<string, number> {
  const limits = new Map<string, number>();

  for (const [modelName, rawModelPricing] of Object.entries(asRecord(payload) ?? {})) {
    const key = normalizeKey(modelName);
    const maxInputTokens = toNonNegativeNumber(asRecord(rawModelPricing)?.max_input_tokens);

    if (pricingByModel.has(key) && maxInputTokens) {
      limits.set(key, maxInputTokens);
    }
  }

  return limits;
}

const TIER_RATE_FIELDS: readonly TierRateField[] = [
  'inputPer1MUsd',
  'outputPer1MUsd',
  'cacheReadPer1MUsd',
  'cacheWritePer1MUsd',
  'cacheWrite1hPer1MUsd',
];

function normalizeCachedTiers(rawTiers: unknown): PricingTier[] | undefined {
  if (!Array.isArray(rawTiers)) {
    return undefined;
  }

  const tiersByThreshold = new Map<number, PricingTier>();

  for (const rawTier of rawTiers) {
    const tierRecord = asRecord(rawTier);
    const aboveTokens = toNonNegativeNumber(tierRecord?.aboveTokens);

    if (!tierRecord || aboveTokens === undefined || !Number.isSafeInteger(aboveTokens)) {
      continue;
    }

    const tier: PricingTier = { aboveTokens };

    for (const field of TIER_RATE_FIELDS) {
      const rate = toNonNegativeNumber(tierRecord[field]);

      if (rate !== undefined) {
        tier[field] = rate;
      }
    }

    tiersByThreshold.set(aboveTokens, tier);
  }

  return tiersByThreshold.size === 0 ? undefined : sortTiersDescending(tiersByThreshold);
}

const PRIORITY_FALLBACK_BUCKETS: readonly PriorityFallbackBucket[] = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
];

function normalizeCachedPriorityFallback(value: unknown): PriorityFallbackBucket[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const buckets = PRIORITY_FALLBACK_BUCKETS.filter((bucket) => value.includes(bucket));
  return buckets.length === 0 ? undefined : buckets;
}

function normalizeCachedPricing(rawPricing: unknown): ModelPricing | undefined {
  const pricingRecord = asRecord(rawPricing);

  if (!pricingRecord) {
    return undefined;
  }

  const inputPer1MUsd = toNonNegativeNumber(pricingRecord.inputPer1MUsd);
  const outputPer1MUsd = toNonNegativeNumber(pricingRecord.outputPer1MUsd);

  if (inputPer1MUsd === undefined || outputPer1MUsd === undefined) {
    return undefined;
  }

  const modelPricing: ModelPricing = {
    inputPer1MUsd,
    outputPer1MUsd,
  };

  const cacheReadPer1MUsd = toNonNegativeNumber(pricingRecord.cacheReadPer1MUsd);

  if (cacheReadPer1MUsd !== undefined) {
    modelPricing.cacheReadPer1MUsd = cacheReadPer1MUsd;
  }

  const cacheWritePer1MUsd = toNonNegativeNumber(pricingRecord.cacheWritePer1MUsd);

  if (cacheWritePer1MUsd !== undefined) {
    modelPricing.cacheWritePer1MUsd = cacheWritePer1MUsd;
  }

  const cacheWrite1hPer1MUsd = toNonNegativeNumber(pricingRecord.cacheWrite1hPer1MUsd);

  if (cacheWrite1hPer1MUsd !== undefined) {
    modelPricing.cacheWrite1hPer1MUsd = cacheWrite1hPer1MUsd;
  }

  const reasoningPer1MUsd = toNonNegativeNumber(pricingRecord.reasoningPer1MUsd);

  if (reasoningPer1MUsd !== undefined) {
    modelPricing.reasoningPer1MUsd = reasoningPer1MUsd;
    modelPricing.reasoningBilling = 'separate';
  }

  const priorityFallback = normalizeCachedPriorityFallback(pricingRecord.priorityFallback);

  if (priorityFallback) {
    modelPricing.priorityFallback = priorityFallback;
  }

  const tiers = normalizeCachedTiers(pricingRecord.tiers);

  if (tiers) {
    modelPricing.tiers = tiers;
  }

  return modelPricing;
}

export function normalizeLiteLLMCachePayload(payload: unknown): LiteLLMCachePayload | undefined {
  const payloadRecord = asRecord(payload);

  if (!payloadRecord) {
    return undefined;
  }

  const fetchedAt = toNonNegativeNumber(payloadRecord.fetchedAt);
  const sourceUrl =
    typeof payloadRecord.sourceUrl === 'string' ? payloadRecord.sourceUrl : undefined;
  const pricingByModelRecord = asRecord(payloadRecord.pricingByModel);

  if (fetchedAt === undefined || !sourceUrl || !pricingByModelRecord) {
    return undefined;
  }

  const pricingByModel: Record<string, ModelPricing> = {};

  for (const [modelName, rawPricing] of Object.entries(pricingByModelRecord)) {
    const pricing = normalizeCachedPricing(rawPricing);

    if (!pricing) {
      continue;
    }

    pricingByModel[modelName] = pricing;
  }

  const maxInputTokensByModel = asRecord(payloadRecord.maxInputTokensByModel);

  return {
    fetchedAt,
    sourceUrl,
    pricingByModel,
    ...(maxInputTokensByModel ? { maxInputTokensByModel } : {}),
  };
}

/**
 * One key's positive limit from a record of limits keyed by normalized pricing key. Read one
 * entry at a time, so loading pricing never walks the thousands of limits only the context
 * report asks for.
 */
function readContextLimit(
  limits: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const limit = limits && Object.hasOwn(limits, key) ? toNonNegativeNumber(limits[key]) : undefined;

  return limit === 0 ? undefined : limit;
}

function getBundledLiteLLMPricingSnapshot(): LiteLLMCachePayload {
  if (bundledLiteLLMPricingSnapshot) {
    return bundledLiteLLMPricingSnapshot;
  }

  const snapshot = normalizeLiteLLMCachePayload(litellmPricingSnapshotPayload);

  if (!snapshot || Object.keys(snapshot.pricingByModel).length === 0) {
    throw new Error('Bundled LiteLLM pricing snapshot is not usable');
  }

  bundledLiteLLMPricingSnapshot = snapshot;
  return snapshot;
}

let retiredLiteLLMPricing: ReadonlyMap<string, ModelPricing> | undefined;

/**
 * Models LiteLLM no longer lists, kept from earlier snapshots by the snapshot generator.
 * Their prices still apply to historical usage, so they back-fill any default-source
 * pricing that lacks them.
 */
function getRetiredLiteLLMPricing(): ReadonlyMap<string, ModelPricing> {
  if (retiredLiteLLMPricing) {
    return retiredLiteLLMPricing;
  }

  const retiredPricing = new Map<string, ModelPricing>();
  const pricingRecord = asRecord(asRecord(litellmRetiredPricingPayload)?.pricingByModel) ?? {};

  for (const [modelName, rawPricing] of Object.entries(pricingRecord)) {
    const pricing = normalizeCachedPricing(rawPricing);

    if (pricing) {
      retiredPricing.set(normalizeKey(modelName), pricing);
    }
  }

  retiredLiteLLMPricing = retiredPricing;
  return retiredPricing;
}

function formatBundledSnapshotWarning(fetchedAt: number): string {
  const fetchedDate = new Date(fetchedAt).toISOString().slice(0, 10);
  return `Pricing: using the bundled LiteLLM snapshot from ${fetchedDate} (run online to refresh).`;
}

function formatStaleCacheWarning(fetchedAt: number, fetchError: string | undefined): string {
  const fetchedDate = new Date(fetchedAt).toISOString().slice(0, 10);

  if (fetchError === undefined) {
    return `Pricing: using cached LiteLLM pricing from ${fetchedDate}, past its refresh interval (run online to refresh).`;
  }

  return `Pricing: the LiteLLM refresh failed (${fetchError}); using cached pricing from ${fetchedDate}.`;
}

export class LiteLLMPricingFetcher implements PricingSource {
  private readonly sourceUrl: string;
  private readonly cacheFilePath: string;
  private readonly cacheTtlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly fetchRetryCount: number;
  private readonly fetchRetryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly offline: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private pricingByModel = new Map<string, ModelPricing>();
  private maxInputTokensByModel: Readonly<Record<string, unknown>> | undefined;
  private resolvedAliasCache = new Map<string, string>();
  private loadOrigin: LiteLLMPricingLoadOrigin | undefined;
  private dataOrigin: PricingDataOrigin | undefined;
  /** Keys the retired prices back-filled into the loaded pricing. */
  private retiredModelKeys = new Set<string>();
  private pricingWarning: string | undefined;

  public constructor(options: LiteLLMPricingFetcherOptions) {
    this.sourceUrl = options.sourceUrl ?? DEFAULT_LITELLM_PRICING_URL;
    this.cacheFilePath = options.cacheFilePath;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchRetryCount =
      Number.isFinite(options.fetchRetryCount) && (options.fetchRetryCount ?? 0) >= 0
        ? Math.trunc(options.fetchRetryCount ?? DEFAULT_FETCH_RETRY_COUNT)
        : DEFAULT_FETCH_RETRY_COUNT;
    this.fetchRetryDelayMs =
      Number.isFinite(options.fetchRetryDelayMs) && (options.fetchRetryDelayMs ?? 0) > 0
        ? Math.trunc(options.fetchRetryDelayMs ?? DEFAULT_FETCH_RETRY_DELAY_MS)
        : DEFAULT_FETCH_RETRY_DELAY_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_LITELLM_PRICING_RESPONSE_BYTES;
    this.offline = options.offline ?? false;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /**
   * Loads pricing data from cache, remote, or the bundled default snapshot.
   * @returns Promise<boolean> True if loaded without a network fetch, false if from network
   */
  public async load(): Promise<boolean> {
    this.loadOrigin = undefined;
    this.dataOrigin = undefined;
    this.pricingWarning = undefined;

    const cacheLoaded = await this.loadFromCache({ allowStale: false });

    if (cacheLoaded) {
      return true;
    }

    if (this.offline) {
      const staleCacheLoaded = await this.loadFromCache({ allowStale: true });

      if (!staleCacheLoaded) {
        const bundledSnapshotLoaded = this.loadFromBundledSnapshot();

        if (!bundledSnapshotLoaded) {
          throw new Error(
            'Offline pricing mode enabled but no cached LiteLLM pricing is available',
          );
        }

        return true;
      }

      return true;
    }

    try {
      await this.loadFromRemote();
      return false;
    } catch (error) {
      const staleCacheLoaded = await this.loadFromCache({
        allowStale: true,
        fetchError: error instanceof Error ? error.message : String(error),
      });

      if (!staleCacheLoaded) {
        const bundledSnapshotLoaded = this.loadFromBundledSnapshot();

        if (!bundledSnapshotLoaded) {
          throw new Error('Could not load LiteLLM pricing from network or cache', {
            cause: error,
          });
        }

        return true;
      }

      return true;
    }
  }

  public getLoadOrigin(): LiteLLMPricingLoadOrigin | undefined {
    return this.loadOrigin;
  }

  /**
   * Set when a cache is past its refresh interval or the bundled snapshot loaded;
   * undefined after a fresh cache or a network load.
   */
  public getPricingWarning(): string | undefined {
    return this.pricingWarning;
  }

  /** Where the loaded prices came from and when they were fetched; undefined before a load. */
  public getDataOrigin(): PricingDataOrigin | undefined {
    return this.dataOrigin;
  }

  public explainModel(model: string): ModelPricingExplanation {
    const normalizedModel = normalizeKey(model);
    const resolvedModel = this.resolveModelAlias(model);
    const pricing = this.getPricing(resolvedModel);
    const match = explainCanonicalModelKey(normalizedModel, this.pricingByModel);

    return {
      normalizedModel,
      resolvedModel,
      ...(match ? { match } : {}),
      override: 'none',
      ...(this.dataOrigin ? { origin: this.dataOrigin } : {}),
      retired: pricing !== undefined && this.retiredModelKeys.has(resolvedModel),
      ...(pricing ? { pricing } : {}),
    };
  }

  public resolveModelAlias(model: string): string {
    const normalizedModel = normalizeKey(model);
    const cachedAlias = this.resolvedAliasCache.get(normalizedModel);

    if (cachedAlias) {
      return cachedAlias;
    }

    const resolvedAlias =
      resolveCanonicalModelKey(normalizedModel, this.pricingByModel) ?? normalizedModel;
    this.resolvedAliasCache.set(normalizedModel, resolvedAlias);

    return resolvedAlias;
  }

  public getPricing(model: string): ModelPricing | undefined {
    const resolvedModel = this.resolveModelAlias(model);
    return this.pricingByModel.get(resolvedModel);
  }

  /**
   * The limit the loaded pricing lists for the model's key. Default-source pricing falls back
   * on the bundled limits, which cover the snapshot and caches written before limits were kept.
   */
  public getMaxInputTokens(model: string): number | undefined {
    const key = this.resolveModelAlias(model);

    return (
      readContextLimit(this.maxInputTokensByModel, key) ??
      (this.sourceUrl === DEFAULT_LITELLM_PRICING_URL
        ? readContextLimit(litellmContextLimitsPayload.maxInputTokensByModel, key)
        : undefined)
    );
  }

  private async fetchRemotePricingResponse(): Promise<Response> {
    const response = await this.fetchImpl(this.sourceUrl, {
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });

    if (!response.ok) {
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableLiteLLMFetchError(
          `Retryable LiteLLM pricing response status: HTTP ${response.status}`,
        );
      }

      throw new Error(`Failed to fetch LiteLLM pricing: HTTP ${response.status}`);
    }

    return response;
  }

  private async fetchRemotePricingResponseWithRetry(): Promise<Response> {
    const maxAttempts = this.fetchRetryCount + 1;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      try {
        return await this.fetchRemotePricingResponse();
      } catch (error) {
        const shouldRetry = isRetryableFetchFailure(error) && attemptIndex < maxAttempts - 1;

        if (!shouldRetry) {
          throw error;
        }
      }

      const backoffDelay = this.fetchRetryDelayMs * 2 ** attemptIndex;
      await this.sleep(backoffDelay);
    }

    throw new Error('Failed to fetch LiteLLM pricing after retries');
  }

  private async readPayloadWithByteLimit(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length'));

    if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
      throw new Error(
        `LiteLLM pricing response exceeds ${this.maxResponseBytes} bytes (content-length ${contentLength})`,
      );
    }

    if (!response.body) {
      const text = await response.text();

      if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
        throw new Error(`LiteLLM pricing response exceeds ${this.maxResponseBytes} bytes`);
      }

      return JSON.parse(text) as unknown;
    }

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    for await (const chunk of response.body as ReadableStream<Uint8Array>) {
      receivedBytes += chunk.byteLength;

      if (receivedBytes > this.maxResponseBytes) {
        throw new Error(`LiteLLM pricing response exceeds ${this.maxResponseBytes} bytes`);
      }

      chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  private async loadFromRemote(): Promise<void> {
    const response = await this.fetchRemotePricingResponseWithRetry();
    const payload = await this.readPayloadWithByteLimit(response);
    const normalizedPricing = normalizeLitellmPricingPayload(payload);

    this.pricingByModel = normalizedPricing;
    this.maxInputTokensByModel = Object.fromEntries(
      normalizeLitellmContextLimits(payload, normalizedPricing),
    );
    this.resolvedAliasCache.clear();
    this.loadOrigin = 'network';
    this.dataOrigin = { kind: 'network', fetchedAt: this.now(), url: this.sourceUrl };
    this.pricingWarning = undefined;

    try {
      await this.writeCache();
    } catch {
      // Cache writes are best-effort. A successful remote fetch must still be usable.
    }

    this.backfillRetiredModels();
  }

  private async loadFromCache(options: {
    allowStale: boolean;
    fetchError?: string;
  }): Promise<boolean> {
    const cacheFileContent = await this.readCachePayload();

    if (!cacheFileContent) {
      return false;
    }

    if (cacheFileContent.sourceUrl !== this.sourceUrl) {
      return false;
    }

    const isCurrentFormat = cacheFileContent.formatVersion === CACHE_FORMAT_VERSION;

    // An older-format default-source cache lacks rates the bundled snapshot carries.
    if (!isCurrentFormat && this.sourceUrl === DEFAULT_LITELLM_PRICING_URL) {
      return false;
    }

    const nowTimestamp = this.now();
    const isStale =
      !isCurrentFormat ||
      cacheFileContent.fetchedAt > nowTimestamp ||
      nowTimestamp - cacheFileContent.fetchedAt > this.cacheTtlMs;

    if (isStale && !options.allowStale) {
      return false;
    }

    this.pricingByModel = new Map(
      Object.entries(cacheFileContent.pricingByModel).map(([modelName, pricing]) => [
        normalizeKey(modelName),
        pricing,
      ]),
    );
    this.maxInputTokensByModel = cacheFileContent.maxInputTokensByModel;
    this.resolvedAliasCache.clear();

    if (this.pricingByModel.size === 0) {
      return false;
    }

    this.loadOrigin = 'cache';
    this.dataOrigin = {
      kind: 'cache',
      fetchedAt: cacheFileContent.fetchedAt,
      url: cacheFileContent.sourceUrl,
    };
    this.pricingWarning = isStale
      ? formatStaleCacheWarning(cacheFileContent.fetchedAt, options.fetchError)
      : undefined;
    this.backfillRetiredModels();
    return true;
  }

  private backfillRetiredModels(): void {
    this.retiredModelKeys = new Set();

    if (this.sourceUrl !== DEFAULT_LITELLM_PRICING_URL) {
      return;
    }

    for (const [modelName, pricing] of getRetiredLiteLLMPricing()) {
      if (!this.pricingByModel.has(modelName)) {
        this.pricingByModel.set(modelName, pricing);
        this.retiredModelKeys.add(modelName);
      }
    }
  }

  private loadFromBundledSnapshot(): boolean {
    if (this.sourceUrl !== DEFAULT_LITELLM_PRICING_URL) {
      return false;
    }

    const snapshot = getBundledLiteLLMPricingSnapshot();

    if (snapshot.sourceUrl !== this.sourceUrl) {
      return false;
    }

    this.pricingByModel = new Map(
      Object.entries(snapshot.pricingByModel).map(([modelName, pricing]) => [
        normalizeKey(modelName),
        pricing,
      ]),
    );
    this.maxInputTokensByModel = undefined;
    this.resolvedAliasCache.clear();

    if (this.pricingByModel.size === 0) {
      return false;
    }

    this.loadOrigin = 'bundled-snapshot';
    this.dataOrigin = {
      kind: 'bundled-snapshot',
      fetchedAt: snapshot.fetchedAt,
      url: snapshot.sourceUrl,
    };
    this.pricingWarning = formatBundledSnapshotWarning(snapshot.fetchedAt);
    this.backfillRetiredModels();
    return true;
  }

  private async readCachePayload(): Promise<
    (LiteLLMCachePayload & { formatVersion: unknown }) | undefined
  > {
    let content: string;

    try {
      content = await readRegularTextFile(this.cacheFilePath);
    } catch {
      return undefined;
    }

    let parsedPayload: unknown;

    try {
      parsedPayload = JSON.parse(content);
    } catch {
      return undefined;
    }

    const payload = normalizeLiteLLMCachePayload(parsedPayload);
    return payload && { ...payload, formatVersion: asRecord(parsedPayload)?.formatVersion };
  }

  private async writeCache(): Promise<void> {
    const directoryPath = path.dirname(this.cacheFilePath);
    await ensureDirectory(directoryPath);

    const payload: LiteLLMCachePayload & { formatVersion: number } = {
      formatVersion: CACHE_FORMAT_VERSION,
      fetchedAt: this.now(),
      sourceUrl: this.sourceUrl,
      pricingByModel: Object.fromEntries(this.pricingByModel.entries()),
      maxInputTokensByModel: this.maxInputTokensByModel,
    };

    await writeFileAtomic(this.cacheFilePath, JSON.stringify(payload));
  }
}
