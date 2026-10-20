import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { asRecord } from '../utils/as-record.js';
import { ensureDirectory, readRegularTextFile, writeFileAtomic } from '../utils/fs-helpers.js';
import { normalizeKey } from './litellm-model-matching.js';
import { PricingTable, toNonNegativeNumber } from './pricing-table.js';
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
export const DEFAULT_FETCH_TIMEOUT_MS = 4000;
export const DEFAULT_FETCH_RETRY_COUNT = 2;
export const DEFAULT_FETCH_RETRY_DELAY_MS = 200;
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
  /**
   * The snapshot, retired prices and context limits default-source pricing falls back on;
   * the files this package ships by default.
   */
  bundledPricing?: BundledPricingData;
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

export function normalizeCachedPricing(rawPricing: unknown): ModelPricing | undefined {
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

/** The bundled data files: the snapshot, the retired prices and the context limits. */
export type BundledPricingFile = 'snapshot' | 'retiredPricing' | 'contextLimits';

/** `promise`, with `forget` called when it rejects, so a memo of it retries on the next call. */
export function forgetOnRejection<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  return promise.catch((error: unknown) => {
    forget();
    throw error;
  });
}

/**
 * The pricing data the package bundles, normalized on first use and kept; a failed read is
 * retried on the next call. `readFile` returns a file's parsed JSON: the library reads the
 * files next to its build, the CLI passes the JSON it inlines. The returned rates are shared:
 * do not change them.
 */
export class BundledPricingData {
  private snapshotPromise: Promise<LiteLLMCachePayload> | undefined;
  private retiredPricingPromise: Promise<ReadonlyMap<string, ModelPricing>> | undefined;
  private contextLimitsPromise: Promise<Readonly<Record<string, unknown>>> | undefined;

  public constructor(private readonly readFile: (file: BundledPricingFile) => Promise<unknown>) {}

  public snapshot(): Promise<LiteLLMCachePayload> {
    this.snapshotPromise ??= forgetOnRejection(
      this.readFile('snapshot').then((payload) => {
        const snapshot = normalizeLiteLLMCachePayload(payload);

        if (!snapshot || Object.keys(snapshot.pricingByModel).length === 0) {
          throw new Error('Bundled LiteLLM pricing snapshot is not usable');
        }

        return snapshot;
      }),
      () => {
        this.snapshotPromise = undefined;
      },
    );
    return this.snapshotPromise;
  }

  /**
   * Models LiteLLM no longer lists, kept from earlier snapshots by the snapshot generator.
   * Their prices still apply to historical usage, so they back-fill any default-source
   * pricing that lacks them.
   */
  public retiredPricing(): Promise<ReadonlyMap<string, ModelPricing>> {
    this.retiredPricingPromise ??= forgetOnRejection(
      this.readFile('retiredPricing').then((payload) => {
        const retiredPricing = new Map<string, ModelPricing>();
        const pricingRecord = asRecord(asRecord(payload)?.pricingByModel) ?? {};

        for (const [modelName, rawPricing] of Object.entries(pricingRecord)) {
          const pricing = normalizeCachedPricing(rawPricing);

          if (pricing) {
            retiredPricing.set(normalizeKey(modelName), pricing);
          }
        }

        return retiredPricing;
      }),
      () => {
        this.retiredPricingPromise = undefined;
      },
    );
    return this.retiredPricingPromise;
  }

  /** Context limits by normalized pricing key, for the snapshot and older caches. */
  public maxInputTokensByModel(): Promise<Readonly<Record<string, unknown>>> {
    this.contextLimitsPromise ??= forgetOnRejection(
      this.readFile('contextLimits').then(
        (payload) => asRecord(asRecord(payload)?.maxInputTokensByModel) ?? {},
      ),
      () => {
        this.contextLimitsPromise = undefined;
      },
    );
    return this.contextLimitsPromise;
  }
}

/**
 * The data files this package ships, read from `./data/` next to this module on first use.
 * Both `./internal` and `./pricing` use this module, so the build puts it in a shared chunk
 * at the root of `dist/` and copies the files to `dist/data/`.
 */
export const packagedPricingData = new BundledPricingData(async (file) => {
  const content = await readFile(packagedPricingFileUrl(file), 'utf8');
  return JSON.parse(content) as unknown;
});

// Literal URLs, which a bundler such as webpack 5 can find and copy as assets.
function packagedPricingFileUrl(file: BundledPricingFile): URL {
  switch (file) {
    case 'snapshot':
      return new URL('./data/litellm-pricing-snapshot.json', import.meta.url);
    case 'retiredPricing':
      return new URL('./data/litellm-retired-pricing.json', import.meta.url);
    case 'contextLimits':
      return new URL('./data/litellm-context-limits.json', import.meta.url);
  }
}

/** Rates keyed by normalized model key, in the record's order. */
export function toPricingMap(
  pricingByModel: Record<string, ModelPricing>,
): Map<string, ModelPricing> {
  return new Map(
    Object.entries(pricingByModel).map(([modelName, pricing]) => [
      normalizeKey(modelName),
      pricing,
    ]),
  );
}

/**
 * A pricing source over LiteLLM rates. With `bundledPricing` (default-source pricing), the
 * retired prices back-fill the keys `pricingByModel` lacks, appended to it, and the bundled
 * context limits stand in where the loaded ones list none.
 */
export async function createLiteLLMPricingTable(
  pricingByModel: Map<string, ModelPricing>,
  options: {
    maxInputTokensByModel?: Readonly<Record<string, unknown>>;
    origin: PricingDataOrigin;
    bundledPricing: BundledPricingData | undefined;
  },
): Promise<PricingTable> {
  const { maxInputTokensByModel, origin, bundledPricing } = options;

  if (!bundledPricing) {
    return new PricingTable(pricingByModel, {
      ...(maxInputTokensByModel ? { maxInputTokensByModel } : {}),
      origin,
    });
  }

  const [retiredPricing, bundledMaxInputTokensByModel] = await Promise.all([
    bundledPricing.retiredPricing(),
    bundledPricing.maxInputTokensByModel(),
  ]);
  const retiredModelKeys = new Set<string>();

  for (const [modelName, pricing] of retiredPricing) {
    if (!pricingByModel.has(modelName)) {
      pricingByModel.set(modelName, pricing);
      retiredModelKeys.add(modelName);
    }
  }

  return new PricingTable(pricingByModel, {
    ...(maxInputTokensByModel ? { maxInputTokensByModel } : {}),
    fallbackMaxInputTokensByModel: bundledMaxInputTokensByModel,
    origin,
    retiredModelKeys,
  });
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

/** One request for LiteLLM's pricing JSON, with the retry and size policy of a fetch. */
export type LiteLLMPricingRequest = {
  url: string;
  fetchImpl: typeof fetch;
  /** Each attempt's timeout. */
  timeoutMs: number;
  /** Attempts after the first, for timeouts, network errors and retryable HTTP statuses. */
  retryCount: number;
  /** The first backoff; each retry doubles it. */
  retryDelayMs: number;
  maxResponseBytes: number;
  /** Waits between attempts; pass one that rejects on `signal` so an abort stops the retries. */
  sleep: (delayMs: number) => Promise<void>;
  /** Aborts each attempt, along with its timeout. */
  signal?: AbortSignal;
};

async function fetchPricingResponse(request: LiteLLMPricingRequest): Promise<Response> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const response = await request.fetchImpl(request.url, {
    signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
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

async function fetchPricingResponseWithRetry(request: LiteLLMPricingRequest): Promise<Response> {
  const maxAttempts = request.retryCount + 1;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    try {
      return await fetchPricingResponse(request);
    } catch (error) {
      const shouldRetry = isRetryableFetchFailure(error) && attemptIndex < maxAttempts - 1;

      if (!shouldRetry) {
        throw error;
      }
    }

    const backoffDelay = request.retryDelayMs * 2 ** attemptIndex;
    await request.sleep(backoffDelay);
  }

  throw new Error('Failed to fetch LiteLLM pricing after retries');
}

async function readPayloadWithByteLimit(
  response: Response,
  maxResponseBytes: number,
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new Error(
      `LiteLLM pricing response exceeds ${maxResponseBytes} bytes (content-length ${contentLength})`,
    );
  }

  if (!response.body) {
    const text = await response.text();

    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw new Error(`LiteLLM pricing response exceeds ${maxResponseBytes} bytes`);
    }

    return JSON.parse(text) as unknown;
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    receivedBytes += chunk.byteLength;

    if (receivedBytes > maxResponseBytes) {
      throw new Error(`LiteLLM pricing response exceeds ${maxResponseBytes} bytes`);
    }

    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Fetches LiteLLM's pricing JSON and parses it, unvalidated. */
export async function requestLiteLLMPricingPayload(
  request: LiteLLMPricingRequest,
): Promise<unknown> {
  const response = await fetchPricingResponseWithRetry(request);
  return readPayloadWithByteLimit(response, request.maxResponseBytes);
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
  private readonly bundledPricing: BundledPricingData;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  private table = new PricingTable(new Map());
  private loadOrigin: LiteLLMPricingLoadOrigin | undefined;
  private dataOrigin: PricingDataOrigin | undefined;
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
    this.bundledPricing = options.bundledPricing ?? packagedPricingData;
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
        const bundledSnapshotLoaded = await this.loadFromBundledSnapshot();

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
        const bundledSnapshotLoaded = await this.loadFromBundledSnapshot();

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
    return this.table.explainModel(model);
  }

  public resolveModelAlias(model: string): string {
    return this.table.resolveModelAlias(model);
  }

  public getPricing(model: string): ModelPricing | undefined {
    return this.table.getPricing(model);
  }

  /**
   * The limit the loaded pricing lists for the model's key. Default-source pricing falls back
   * on the bundled limits, which cover the snapshot and caches written before limits were kept.
   */
  public getMaxInputTokens(model: string): number | undefined {
    return this.table.getMaxInputTokens(model);
  }

  private async loadFromRemote(): Promise<void> {
    const payload = await requestLiteLLMPricingPayload({
      url: this.sourceUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.fetchTimeoutMs,
      retryCount: this.fetchRetryCount,
      retryDelayMs: this.fetchRetryDelayMs,
      maxResponseBytes: this.maxResponseBytes,
      sleep: this.sleep,
    });
    const pricingByModel = normalizeLitellmPricingPayload(payload);
    const maxInputTokensByModel = Object.fromEntries(
      normalizeLitellmContextLimits(payload, pricingByModel),
    );
    const origin: PricingDataOrigin = {
      kind: 'network',
      fetchedAt: this.now(),
      url: this.sourceUrl,
    };

    try {
      await this.writeCache(pricingByModel, maxInputTokensByModel);
    } catch {
      // Cache writes are best-effort. A successful remote fetch must still be usable.
    }

    this.table = await createLiteLLMPricingTable(pricingByModel, {
      maxInputTokensByModel,
      origin,
      bundledPricing: this.defaultSourceBundledPricing(),
    });
    this.loadOrigin = 'network';
    this.dataOrigin = origin;
    this.pricingWarning = undefined;
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

    const pricingByModel = toPricingMap(cacheFileContent.pricingByModel);

    if (pricingByModel.size === 0) {
      return false;
    }

    const origin: PricingDataOrigin = {
      kind: 'cache',
      fetchedAt: cacheFileContent.fetchedAt,
      url: cacheFileContent.sourceUrl,
    };
    this.table = await createLiteLLMPricingTable(pricingByModel, {
      ...(cacheFileContent.maxInputTokensByModel
        ? { maxInputTokensByModel: cacheFileContent.maxInputTokensByModel }
        : {}),
      origin,
      bundledPricing: this.defaultSourceBundledPricing(),
    });
    this.loadOrigin = 'cache';
    this.dataOrigin = origin;
    this.pricingWarning = isStale
      ? formatStaleCacheWarning(cacheFileContent.fetchedAt, options.fetchError)
      : undefined;
    return true;
  }

  /** The bundled data for default-source pricing; a custom URL never mixes it in. */
  private defaultSourceBundledPricing(): BundledPricingData | undefined {
    return this.sourceUrl === DEFAULT_LITELLM_PRICING_URL ? this.bundledPricing : undefined;
  }

  private async loadFromBundledSnapshot(): Promise<boolean> {
    if (this.sourceUrl !== DEFAULT_LITELLM_PRICING_URL) {
      return false;
    }

    const snapshot = await this.bundledPricing.snapshot();

    if (snapshot.sourceUrl !== this.sourceUrl) {
      return false;
    }

    const pricingByModel = toPricingMap(snapshot.pricingByModel);

    if (pricingByModel.size === 0) {
      return false;
    }

    const origin: PricingDataOrigin = {
      kind: 'bundled-snapshot',
      fetchedAt: snapshot.fetchedAt,
      url: snapshot.sourceUrl,
    };
    this.table = await createLiteLLMPricingTable(pricingByModel, {
      origin,
      bundledPricing: this.bundledPricing,
    });
    this.loadOrigin = 'bundled-snapshot';
    this.dataOrigin = origin;
    this.pricingWarning = formatBundledSnapshotWarning(snapshot.fetchedAt);
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

  private async writeCache(
    pricingByModel: ReadonlyMap<string, ModelPricing>,
    maxInputTokensByModel: Record<string, unknown>,
  ): Promise<void> {
    const directoryPath = path.dirname(this.cacheFilePath);
    await ensureDirectory(directoryPath);

    const payload: LiteLLMCachePayload & { formatVersion: number } = {
      formatVersion: CACHE_FORMAT_VERSION,
      fetchedAt: this.now(),
      sourceUrl: this.sourceUrl,
      pricingByModel: Object.fromEntries(pricingByModel.entries()),
      maxInputTokensByModel,
    };

    await writeFileAtomic(this.cacheFilePath, JSON.stringify(payload));
  }
}
