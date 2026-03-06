import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { asRecord } from '../utils/as-record.js';
import { getUserCacheRootDir } from '../utils/cache-root-dir.js';
import { parseVersion } from './version-utils.js';

export const DEFAULT_UPDATE_CHECK_CACHE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_UPDATE_CHECK_FETCH_TIMEOUT_MS = 1000;
const DEFAULT_FETCH_RETRY_COUNT = 2;
const DEFAULT_FETCH_RETRY_DELAY_MS = 200;

export const UPDATE_CHECK_CACHE_SCOPE_ENV_VAR = 'LLM_USAGE_UPDATE_CACHE_SCOPE';
export const UPDATE_CHECK_CACHE_SESSION_KEY_ENV_VAR = 'LLM_USAGE_UPDATE_CACHE_SESSION_KEY';

export type UpdateCheckCachePayload = {
  checkedAt: number;
  latestVersion: string;
};

export type ResolveLatestVersionOptions = {
  packageName: string;
  cacheFilePath?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  fetchRetryCount?: number;
  fetchRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

class RetryableFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RetryableFetchError';
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableFetchFailure(error: unknown): boolean {
  if (error instanceof RetryableFetchError) {
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

export function getDefaultUpdateCheckCachePath(): string {
  return path.join(getUserCacheRootDir(), 'llm-usage-metrics', 'update-check.json');
}

function sanitizeCachePathFragment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_');
}

function toCacheSessionKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return undefined;
  }

  const sanitizedValue = sanitizeCachePathFragment(trimmedValue);
  return sanitizedValue || undefined;
}

export function getSessionScopedCachePath(
  baseCacheFilePath: string,
  env: NodeJS.ProcessEnv,
  options: { parentPid?: number } = {},
): string {
  const cacheScope = env[UPDATE_CHECK_CACHE_SCOPE_ENV_VAR]?.trim().toLowerCase();

  if (cacheScope !== 'session') {
    return baseCacheFilePath;
  }

  const parentPid = options.parentPid ?? process.ppid;
  const sessionKey =
    toCacheSessionKey(env[UPDATE_CHECK_CACHE_SESSION_KEY_ENV_VAR]) ?? `ppid-${parentPid}`;

  const parsedPath = path.parse(baseCacheFilePath);
  return path.join(parsedPath.dir, `${parsedPath.name}.${sessionKey}${parsedPath.ext}`);
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }

  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function isValidVersion(value: string): boolean {
  return parseVersion(value) !== undefined;
}

export function isCacheFresh(
  payload: Pick<UpdateCheckCachePayload, 'checkedAt'>,
  cacheTtlMs: number,
  now: () => number,
): boolean {
  const nowTimestamp = now();

  if (payload.checkedAt > nowTimestamp) {
    return false;
  }

  return nowTimestamp - payload.checkedAt <= cacheTtlMs;
}

export async function readUpdateCheckCachePayload(
  cacheFilePath: string,
): Promise<UpdateCheckCachePayload | undefined> {
  let content: string;

  try {
    content = await readFile(cacheFilePath, 'utf8');
  } catch {
    return undefined;
  }

  let parsedContent: unknown;

  try {
    parsedContent = JSON.parse(content);
  } catch {
    return undefined;
  }

  const record = asRecord(parsedContent);

  if (!record) {
    return undefined;
  }

  const checkedAt = toNonNegativeNumber(record.checkedAt);
  const latestVersion = typeof record.latestVersion === 'string' ? record.latestVersion.trim() : '';

  if (checkedAt === undefined || !latestVersion || !isValidVersion(latestVersion)) {
    return undefined;
  }

  return {
    checkedAt,
    latestVersion,
  };
}

export async function writeUpdateCheckCachePayload(
  cacheFilePath: string,
  payload: UpdateCheckCachePayload,
): Promise<void> {
  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(cacheFilePath, JSON.stringify(payload), 'utf8');
}

async function fetchLatestVersion(
  packageName: string,
  fetchImpl: typeof fetch,
  fetchTimeoutMs: number,
): Promise<string | undefined> {
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    },
  );

  if (!response.ok) {
    if (isRetryableHttpStatus(response.status)) {
      throw new RetryableFetchError(
        `Retryable update-check response status: HTTP ${response.status}`,
      );
    }

    return undefined;
  }

  let payload: unknown;

  try {
    payload = (await response.json()) as unknown;
  } catch {
    return undefined;
  }

  const payloadRecord = asRecord(payload);

  if (!payloadRecord) {
    return undefined;
  }

  const version = typeof payloadRecord.version === 'string' ? payloadRecord.version.trim() : '';

  if (!version || !isValidVersion(version)) {
    return undefined;
  }

  return version;
}

async function fetchLatestVersionWithRetry(
  packageName: string,
  fetchImpl: typeof fetch,
  fetchTimeoutMs: number,
  fetchRetryCount: number,
  fetchRetryDelayMs: number,
  sleepFn: (delayMs: number) => Promise<void>,
): Promise<string | undefined> {
  const safeRetryCount =
    Number.isFinite(fetchRetryCount) && fetchRetryCount >= 0
      ? Math.trunc(fetchRetryCount)
      : DEFAULT_FETCH_RETRY_COUNT;
  const safeRetryDelayMs =
    Number.isFinite(fetchRetryDelayMs) && fetchRetryDelayMs > 0
      ? Math.trunc(fetchRetryDelayMs)
      : DEFAULT_FETCH_RETRY_DELAY_MS;
  const maxAttempts = safeRetryCount + 1;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    try {
      return await fetchLatestVersion(packageName, fetchImpl, fetchTimeoutMs);
    } catch (error) {
      const shouldRetry = isRetryableFetchFailure(error) && attemptIndex < maxAttempts - 1;

      if (!shouldRetry) {
        throw error;
      }
    }

    const backoffDelay = safeRetryDelayMs * 2 ** attemptIndex;
    await sleepFn(backoffDelay);
  }

  return undefined;
}

export async function resolveLatestVersion(
  options: ResolveLatestVersionOptions,
): Promise<string | undefined> {
  const cacheFilePath = options.cacheFilePath ?? getDefaultUpdateCheckCachePath();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_UPDATE_CHECK_CACHE_TTL_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_UPDATE_CHECK_FETCH_TIMEOUT_MS;
  const fetchRetryCount = options.fetchRetryCount ?? DEFAULT_FETCH_RETRY_COUNT;
  const fetchRetryDelayMs = options.fetchRetryDelayMs ?? DEFAULT_FETCH_RETRY_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleepFn = options.sleep ?? sleep;

  const cachePayload = await readUpdateCheckCachePayload(cacheFilePath);

  if (cachePayload && isCacheFresh(cachePayload, cacheTtlMs, now)) {
    return cachePayload.latestVersion;
  }

  try {
    const latestVersion = await fetchLatestVersionWithRetry(
      options.packageName,
      fetchImpl,
      fetchTimeoutMs,
      fetchRetryCount,
      fetchRetryDelayMs,
      sleepFn,
    );

    if (!latestVersion) {
      return cachePayload?.latestVersion;
    }

    try {
      await writeUpdateCheckCachePayload(cacheFilePath, {
        checkedAt: now(),
        latestVersion,
      });
    } catch {
      // Cache writes are best-effort.
    }

    return latestVersion;
  } catch {
    return cachePayload?.latestVersion;
  }
}
