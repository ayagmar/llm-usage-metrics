import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { asRecord } from '../utils/as-record.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';
import { normalizeKey, resolveCanonicalModelKey } from './litellm-model-matching.js';
import litellmPricingSnapshotPayload from './litellm-pricing-snapshot.json' with { type: 'json' };
import type { ModelPricing, PricingSource } from './types.js';

const ONE_MILLION = 1_000_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;
const DEFAULT_FETCH_RETRY_COUNT = 2;
const DEFAULT_FETCH_RETRY_DELAY_MS = 200;
export const MAX_LITELLM_PRICING_RESPONSE_BYTES = 33_554_432;

export const DEFAULT_LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export type LiteLLMCachePayload = {
  fetchedAt: number;
  sourceUrl: string;
  pricingByModel: Record<string, ModelPricing>;
};

export type LiteLLMPricingLoadOrigin = 'cache' | 'network' | 'bundled-snapshot';

export type LiteLLMPricingFetcherOptions = {
  sourceUrl?: string;
  cacheFilePath?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  fetchRetryCount?: number;
  fetchRetryDelayMs?: number;
  maxResponseBytes?: number;
  offline?: boolean;
  fetchImpl?: typeof fetch;
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

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
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

function normalizeModelPricing(rawModelPricing: Record<string, unknown>): ModelPricing | undefined {
  const inputPerToken =
    toNonNegativeNumber(rawModelPricing.input_cost_per_token) ??
    toNonNegativeNumber(rawModelPricing.input_cost_per_token_priority);
  const outputPerToken =
    toNonNegativeNumber(rawModelPricing.output_cost_per_token) ??
    toNonNegativeNumber(rawModelPricing.output_cost_per_token_priority);

  if (inputPerToken === undefined || outputPerToken === undefined) {
    return undefined;
  }

  const cacheReadPerToken =
    toNonNegativeNumber(rawModelPricing.cache_read_input_token_cost) ??
    toNonNegativeNumber(rawModelPricing.cache_read_input_token_cost_priority);
  const cacheWritePerToken =
    toNonNegativeNumber(rawModelPricing.cache_creation_input_token_cost) ??
    toNonNegativeNumber(rawModelPricing.cache_creation_input_token_cost_priority);
  const reasoningPerToken = toNonNegativeNumber(rawModelPricing.output_cost_per_reasoning_token);

  const modelPricing: ModelPricing = {
    inputPer1MUsd: inputPerToken * ONE_MILLION,
    outputPer1MUsd: outputPerToken * ONE_MILLION,
  };

  if (cacheReadPerToken !== undefined) {
    modelPricing.cacheReadPer1MUsd = cacheReadPerToken * ONE_MILLION;
  }

  if (cacheWritePerToken !== undefined) {
    modelPricing.cacheWritePer1MUsd = cacheWritePerToken * ONE_MILLION;
  }

  if (reasoningPerToken !== undefined) {
    modelPricing.reasoningPer1MUsd = reasoningPerToken * ONE_MILLION;
    modelPricing.reasoningBilling = 'separate';
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

  const reasoningPer1MUsd = toNonNegativeNumber(pricingRecord.reasoningPer1MUsd);

  if (reasoningPer1MUsd !== undefined) {
    modelPricing.reasoningPer1MUsd = reasoningPer1MUsd;
    modelPricing.reasoningBilling = 'separate';
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

  return {
    fetchedAt,
    sourceUrl,
    pricingByModel,
  };
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

function formatBundledSnapshotWarning(fetchedAt: number): string {
  const fetchedDate = new Date(fetchedAt).toISOString().slice(0, 10);
  return `Pricing: using the bundled LiteLLM snapshot from ${fetchedDate} (run online to refresh).`;
}

export function getDefaultLiteLLMPricingCachePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'litellm-pricing-cache.json');
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
  private resolvedAliasCache = new Map<string, string>();
  private loadOrigin: LiteLLMPricingLoadOrigin | undefined;
  private pricingWarning: string | undefined;

  public constructor(options: LiteLLMPricingFetcherOptions = {}) {
    this.sourceUrl = options.sourceUrl ?? DEFAULT_LITELLM_PRICING_URL;
    this.cacheFilePath = options.cacheFilePath ?? getDefaultLiteLLMPricingCachePath();
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
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /**
   * Loads pricing data from cache, remote, or the bundled default snapshot.
   * @returns Promise<boolean> True if loaded without a network fetch, false if from network
   */
  public async load(): Promise<boolean> {
    this.loadOrigin = undefined;
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
    } catch {
      const staleCacheLoaded = await this.loadFromCache({ allowStale: true });

      if (!staleCacheLoaded) {
        const bundledSnapshotLoaded = this.loadFromBundledSnapshot();

        if (!bundledSnapshotLoaded) {
          throw new Error('Could not load LiteLLM pricing from network or cache');
        }

        return true;
      }

      return true;
    }
  }

  public getLoadOrigin(): LiteLLMPricingLoadOrigin | undefined {
    return this.loadOrigin;
  }

  public getPricingWarning(): string | undefined {
    return this.pricingWarning;
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

    for await (const chunk of response.body) {
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
    this.resolvedAliasCache.clear();
    this.loadOrigin = 'network';
    this.pricingWarning = undefined;

    try {
      await this.writeCache();
    } catch {
      // Cache writes are best-effort. A successful remote fetch must still be usable.
    }
  }

  private async loadFromCache(options: { allowStale: boolean }): Promise<boolean> {
    const cacheFileContent = await this.readCachePayload();

    if (!cacheFileContent) {
      return false;
    }

    if (cacheFileContent.sourceUrl !== this.sourceUrl) {
      return false;
    }

    const nowTimestamp = this.now();
    const isStale =
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
    this.resolvedAliasCache.clear();

    if (this.pricingByModel.size === 0) {
      return false;
    }

    this.loadOrigin = 'cache';
    this.pricingWarning = undefined;
    return true;
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
    this.resolvedAliasCache.clear();

    if (this.pricingByModel.size === 0) {
      return false;
    }

    this.loadOrigin = 'bundled-snapshot';
    this.pricingWarning = formatBundledSnapshotWarning(snapshot.fetchedAt);
    return true;
  }

  private async readCachePayload(): Promise<LiteLLMCachePayload | undefined> {
    let content: string;

    try {
      content = await readFile(this.cacheFilePath, 'utf8');
    } catch {
      return undefined;
    }

    let parsedPayload: unknown;

    try {
      parsedPayload = JSON.parse(content);
    } catch {
      return undefined;
    }

    return normalizeLiteLLMCachePayload(parsedPayload);
  }

  private async writeCache(): Promise<void> {
    const directoryPath = path.dirname(this.cacheFilePath);
    await mkdir(directoryPath, { recursive: true });

    const payload: LiteLLMCachePayload = {
      fetchedAt: this.now(),
      sourceUrl: this.sourceUrl,
      pricingByModel: Object.fromEntries(this.pricingByModel.entries()),
    };

    await writeFile(this.cacheFilePath, JSON.stringify(payload), 'utf8');
  }
}
