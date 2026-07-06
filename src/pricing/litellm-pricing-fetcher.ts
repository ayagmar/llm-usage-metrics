import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { asRecord } from '../utils/as-record.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';
import litellmModelMapPayload from './litellm-model-map.json' with { type: 'json' };
import type { ModelPricing, PricingSource } from './types.js';

const ONE_MILLION = 1_000_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;
const DEFAULT_FETCH_RETRY_COUNT = 2;
const DEFAULT_FETCH_RETRY_DELAY_MS = 200;
const MAX_PRICING_RESPONSE_BYTES = 33_554_432;

export const DEFAULT_LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

type LiteLLMCachePayload = {
  fetchedAt: number;
  sourceUrl: string;
  pricingByModel: Record<string, ModelPricing>;
};

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

type LiteLLMModelMapPayload = {
  aliases?: unknown;
  neverFuzzyMatch?: unknown;
  preferredPricingKeyByCanonicalModel?: unknown;
};

type LiteLLMModelMap = {
  aliasToCanonicalModel: Map<string, string>;
  canonicalizedAliasToCanonicalModel: Map<string, string>;
  neverFuzzyMatch: Set<string>;
  preferredPricingKeyByCanonicalModel: Map<string, string>;
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

function normalizeKey(value: string): string {
  // Pricing payload keys are normalized separately from event/cache model keys.
  return value.trim().toLowerCase();
}

function parseLiteLLMModelMap(payload: LiteLLMModelMapPayload): LiteLLMModelMap {
  const aliasToCanonicalModel = new Map<string, string>();
  const canonicalizedAliasToCanonicalModel = new Map<string, string>();
  const neverFuzzyMatch = new Set<string>();
  const preferredPricingKeyByCanonicalModel = new Map<string, string>();

  const aliasesRecord = asRecord(payload.aliases);

  if (aliasesRecord) {
    for (const [alias, canonicalModel] of Object.entries(aliasesRecord)) {
      if (typeof canonicalModel !== 'string') {
        continue;
      }

      const normalizedAlias = normalizeKey(alias);
      const normalizedCanonicalModel = normalizeKey(canonicalModel);

      aliasToCanonicalModel.set(normalizedAlias, normalizedCanonicalModel);
      canonicalizedAliasToCanonicalModel.set(
        canonicalizeForFuzzy(normalizedAlias),
        normalizedCanonicalModel,
      );
    }
  }

  if (Array.isArray(payload.neverFuzzyMatch)) {
    for (const model of payload.neverFuzzyMatch) {
      if (typeof model !== 'string') {
        continue;
      }

      neverFuzzyMatch.add(normalizeKey(model));
    }
  }

  const preferredPricingRecord = asRecord(payload.preferredPricingKeyByCanonicalModel);

  if (preferredPricingRecord) {
    for (const [canonicalModel, preferredPricingKey] of Object.entries(preferredPricingRecord)) {
      if (typeof preferredPricingKey !== 'string') {
        continue;
      }

      preferredPricingKeyByCanonicalModel.set(
        normalizeKey(canonicalModel),
        normalizeKey(preferredPricingKey),
      );
    }
  }

  return {
    aliasToCanonicalModel,
    canonicalizedAliasToCanonicalModel,
    neverFuzzyMatch,
    preferredPricingKeyByCanonicalModel,
  };
}

const litellmModelMap = parseLiteLLMModelMap(litellmModelMapPayload);

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

function normalizeLitellmPricingPayload(payload: unknown): Map<string, ModelPricing> {
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

export function getDefaultLiteLLMPricingCachePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'litellm-pricing-cache.json');
}

function stripProviderPrefix(model: string): string {
  const slashIndex = model.lastIndexOf('/');

  if (slashIndex === -1) {
    return model;
  }

  return model.slice(slashIndex + 1);
}

function canonicalizeForFuzzy(value: string): string {
  return value.replace(/[^a-z0-9]/gu, '');
}

function isPrefixModelMatch(candidate: string, modelName: string): boolean {
  if (!candidate.startsWith(modelName)) {
    return false;
  }

  if (candidate.length === modelName.length) {
    return true;
  }

  const nextCharacter = candidate[modelName.length];
  return nextCharacter === '-' || nextCharacter === ':' || nextCharacter === '@';
}

function extractNumericTokens(value: string): string[] {
  return value.match(/\d+/gu) ?? [];
}

function areNumericSignaturesCompatible(left: string, right: string): boolean {
  const leftTokens = extractNumericTokens(left);
  const rightTokens = extractNumericTokens(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return true;
  }

  if (
    leftTokens.length === rightTokens.length &&
    leftTokens.every((token, index) => token === rightTokens[index])
  ) {
    return true;
  }

  if (leftTokens.length === 1 && rightTokens.length > 1 && rightTokens.join('') === leftTokens[0]) {
    return true;
  }

  if (rightTokens.length === 1 && leftTokens.length > 1 && leftTokens.join('') === rightTokens[0]) {
    return true;
  }

  return false;
}

function levenshteinDistance(left: string, right: string): number {
  const leftLength = left.length;
  const rightLength = right.length;

  const matrix = Array.from({ length: leftLength + 1 }, (_, rowIndex) => {
    return Array.from({ length: rightLength + 1 }, (_, columnIndex) => {
      if (rowIndex === 0) {
        return columnIndex;
      }

      if (columnIndex === 0) {
        return rowIndex;
      }

      return 0;
    });
  });

  for (let rowIndex = 1; rowIndex <= leftLength; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex <= rightLength; columnIndex += 1) {
      const substitutionCost = left[rowIndex - 1] === right[columnIndex - 1] ? 0 : 1;

      matrix[rowIndex][columnIndex] = Math.min(
        matrix[rowIndex - 1][columnIndex] + 1,
        matrix[rowIndex][columnIndex - 1] + 1,
        matrix[rowIndex - 1][columnIndex - 1] + substitutionCost,
      );
    }
  }

  return matrix[leftLength][rightLength];
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
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_PRICING_RESPONSE_BYTES;
    this.offline = options.offline ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  /**
   * Loads pricing data from cache or remote.
   * @returns Promise<boolean> True if loaded from cache, false if from network
   */
  public async load(): Promise<boolean> {
    const cacheLoaded = await this.loadFromCache({ allowStale: false });

    if (cacheLoaded) {
      return true;
    }

    if (this.offline) {
      const staleCacheLoaded = await this.loadFromCache({ allowStale: true });

      if (!staleCacheLoaded) {
        throw new Error('Offline pricing mode enabled but no cached LiteLLM pricing is available');
      }

      return true;
    }

    try {
      await this.loadFromRemote();
      return false;
    } catch {
      const staleCacheLoaded = await this.loadFromCache({ allowStale: true });

      if (!staleCacheLoaded) {
        throw new Error('Could not load LiteLLM pricing from network or cache');
      }

      return true;
    }
  }

  public resolveModelAlias(model: string): string {
    const normalizedModel = normalizeKey(model);
    const cachedAlias = this.resolvedAliasCache.get(normalizedModel);

    if (cachedAlias) {
      return cachedAlias;
    }

    const mappedAlias = this.resolveMappedModelAlias(normalizedModel);

    if (mappedAlias) {
      this.resolvedAliasCache.set(normalizedModel, mappedAlias);
      return mappedAlias;
    }

    const directMatch = this.resolveDirectModelMatch(normalizedModel);

    if (directMatch) {
      this.resolvedAliasCache.set(normalizedModel, directMatch);
      return directMatch;
    }

    const providerPrefixedMatch = this.resolveProviderPrefixedModelMatch(normalizedModel);

    if (providerPrefixedMatch) {
      this.resolvedAliasCache.set(normalizedModel, providerPrefixedMatch);
      return providerPrefixedMatch;
    }

    const prefixMatch = this.resolvePrefixModelMatch(normalizedModel);

    if (prefixMatch) {
      this.resolvedAliasCache.set(normalizedModel, prefixMatch);
      return prefixMatch;
    }

    const fuzzyMatch = this.shouldSkipFuzzyModelMatch(normalizedModel)
      ? undefined
      : this.resolveFuzzyModelMatch(normalizedModel);
    const resolvedAlias = fuzzyMatch ?? normalizedModel;
    this.resolvedAliasCache.set(normalizedModel, resolvedAlias);

    return resolvedAlias;
  }

  public getPricing(model: string): ModelPricing | undefined {
    const resolvedModel = this.resolveModelAlias(model);
    return this.pricingByModel.get(resolvedModel);
  }

  private resolveMappedModelAlias(normalizedModel: string): string | undefined {
    const canonicalModel = this.resolveCanonicalModelName(normalizedModel);

    if (!canonicalModel) {
      return undefined;
    }

    const preferredPricingKey =
      litellmModelMap.preferredPricingKeyByCanonicalModel.get(canonicalModel);

    if (preferredPricingKey && this.pricingByModel.has(preferredPricingKey)) {
      return preferredPricingKey;
    }

    const directCanonicalMatch = this.resolveDirectModelMatch(canonicalModel);

    if (directCanonicalMatch) {
      return directCanonicalMatch;
    }

    const providerPrefixedCanonicalMatch = this.resolveProviderPrefixedModelMatch(canonicalModel);

    if (providerPrefixedCanonicalMatch) {
      return providerPrefixedCanonicalMatch;
    }

    const prefixCanonicalMatch = this.resolvePrefixModelMatch(canonicalModel);

    if (prefixCanonicalMatch) {
      return prefixCanonicalMatch;
    }

    return this.shouldSkipFuzzyModelMatch(canonicalModel)
      ? undefined
      : this.resolveFuzzyModelMatch(canonicalModel);
  }

  private resolveCanonicalModelName(normalizedModel: string): string | undefined {
    const strippedModel = stripProviderPrefix(normalizedModel);

    const directCanonicalMatch =
      litellmModelMap.aliasToCanonicalModel.get(normalizedModel) ??
      litellmModelMap.aliasToCanonicalModel.get(strippedModel);

    if (directCanonicalMatch) {
      return directCanonicalMatch;
    }

    const canonicalizedModel = canonicalizeForFuzzy(normalizedModel);
    const canonicalizedStrippedModel = canonicalizeForFuzzy(strippedModel);

    return (
      litellmModelMap.canonicalizedAliasToCanonicalModel.get(canonicalizedModel) ??
      litellmModelMap.canonicalizedAliasToCanonicalModel.get(canonicalizedStrippedModel)
    );
  }

  private resolveDirectModelMatch(normalizedModel: string): string | undefined {
    if (this.pricingByModel.has(normalizedModel)) {
      return normalizedModel;
    }

    const strippedModel = stripProviderPrefix(normalizedModel);

    if (this.pricingByModel.has(strippedModel)) {
      return strippedModel;
    }

    return undefined;
  }

  private resolveProviderPrefixedModelMatch(normalizedModel: string): string | undefined {
    const candidates = [normalizedModel, stripProviderPrefix(normalizedModel)];

    for (const candidate of candidates) {
      let bestMatch: string | undefined;

      for (const modelName of this.pricingByModel.keys()) {
        const isProviderPrefixedMatch =
          modelName.endsWith(`/${candidate}`) || modelName.endsWith(`.${candidate}`);

        if (!isProviderPrefixedMatch) {
          continue;
        }

        if (
          !bestMatch ||
          modelName.length < bestMatch.length ||
          (modelName.length === bestMatch.length && compareByCodePoint(modelName, bestMatch) < 0)
        ) {
          bestMatch = modelName;
        }
      }

      if (bestMatch) {
        return bestMatch;
      }
    }

    return undefined;
  }

  private resolvePrefixModelMatch(normalizedModel: string): string | undefined {
    const candidates = [normalizedModel, stripProviderPrefix(normalizedModel)];

    for (const candidate of candidates) {
      let bestMatch: string | undefined;

      for (const modelName of this.pricingByModel.keys()) {
        if (!isPrefixModelMatch(candidate, modelName)) {
          continue;
        }

        if (
          !bestMatch ||
          modelName.length > bestMatch.length ||
          (modelName.length === bestMatch.length && compareByCodePoint(modelName, bestMatch) < 0)
        ) {
          bestMatch = modelName;
        }
      }

      if (bestMatch) {
        return bestMatch;
      }
    }

    return undefined;
  }

  private shouldSkipFuzzyModelMatch(normalizedModel: string): boolean {
    const strippedModel = stripProviderPrefix(normalizedModel);

    return (
      litellmModelMap.neverFuzzyMatch.has(normalizedModel) ||
      litellmModelMap.neverFuzzyMatch.has(strippedModel)
    );
  }

  private resolveFuzzyModelMatch(normalizedModel: string): string | undefined {
    const strippedModel = stripProviderPrefix(normalizedModel);
    const fuzzyTarget = canonicalizeForFuzzy(strippedModel);

    if (!fuzzyTarget) {
      return undefined;
    }

    let bestMatch: { modelName: string; distance: number } | undefined;

    for (const modelName of this.pricingByModel.keys()) {
      if (!areNumericSignaturesCompatible(strippedModel, modelName)) {
        continue;
      }

      const fuzzyModelName = canonicalizeForFuzzy(modelName);

      if (!fuzzyModelName) {
        continue;
      }

      const distance = levenshteinDistance(fuzzyTarget, fuzzyModelName);

      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = { modelName, distance };
      }
    }

    if (!bestMatch) {
      return undefined;
    }

    const maxDistance = Math.max(2, Math.floor(fuzzyTarget.length * 0.2));

    if (bestMatch.distance > maxDistance) {
      return undefined;
    }

    return bestMatch.modelName;
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

    return this.pricingByModel.size > 0;
  }

  private normalizeCachedPricing(rawPricing: unknown): ModelPricing | undefined {
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

    const payloadRecord = asRecord(parsedPayload);

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
      const pricing = this.normalizeCachedPricing(rawPricing);

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
