import { spawn } from 'node:child_process';

import { asRecord } from '@ayagmar/agent-sessions/internal';
import {
  claimBackgroundRefresh,
  getDefaultUpdateCheckCachePath,
  getSessionScopedCachePath,
  resolveLatestVersion,
  type ResolveLatestVersionOptions,
} from './update-cache-repository.js';
import { shouldOfferUpdate } from './version-utils.js';

export {
  UPDATE_CHECK_CACHE_SCOPE_ENV_VAR,
  UPDATE_CHECK_CACHE_SESSION_KEY_ENV_VAR,
  claimBackgroundRefresh,
  getDefaultUpdateCheckCachePath,
  getSessionScopedCachePath,
  isCacheFresh,
  readUpdateCheckCachePayload,
  resolveLatestVersion,
  writeUpdateCheckCachePayload,
  type ResolveLatestVersionOptions,
  type UpdateCheckCachePayload,
} from './update-cache-repository.js';
export {
  compareVersions,
  parseVersion,
  shouldOfferUpdate,
  type ParsedVersion,
} from './version-utils.js';

const UPDATE_CHECK_SKIP_ENV_VAR = 'LLM_USAGE_SKIP_UPDATE_CHECK';
const UPDATE_HINT_EXIT_GRACE_MS = 50;
export const UPDATE_CHECK_BACKGROUND_REFRESH_ENV_VAR = 'LLM_USAGE_UPDATE_CHECK_REFRESH';

/** What a detached refresh process needs to fetch the latest version and cache it. */
export type BackgroundRefreshRequest = {
  packageName: string;
  cacheFilePath: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
};

export type UpdateNotifierOptions = {
  packageName: string;
  currentVersion: string;
  cacheFilePath?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  skipCheck?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  startBackgroundRefresh?: (request: BackgroundRefreshRequest) => void;
};

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue.length === 0) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(normalizedValue);
}

export function shouldSkipUpdateCheckForArgv(argv: string[]): boolean {
  const executableArgs = argv.slice(2);
  const commandNames = new Set([
    'daily',
    'weekly',
    'monthly',
    'efficiency',
    'optimize',
    'statusline',
    'machine',
    'config',
    'completion',
    'help',
    'version',
  ]);

  if (executableArgs.length === 0) {
    return false;
  }

  if (
    executableArgs.some((arg) => ['-h', '--help', '--help-all', '-V', '--version'].includes(arg))
  ) {
    return true;
  }

  const firstRecognizedCommand = executableArgs.find((arg) => commandNames.has(arg));

  // A status line runs constantly and must never print or wait on an update hint, a
  // machine export runs over ssh for another machine's report, `config` only reads
  // and writes the local setup, and `completion` runs at every shell start.
  return (
    firstRecognizedCommand === 'help' ||
    firstRecognizedCommand === 'version' ||
    firstRecognizedCommand === 'statusline' ||
    firstRecognizedCommand === 'config' ||
    firstRecognizedCommand === 'completion' ||
    (firstRecognizedCommand === 'machine' &&
      executableArgs[executableArgs.indexOf('machine') + 1] === 'export')
  );
}

export function isLikelyNpxExecution(argv: string[], env: NodeJS.ProcessEnv): boolean {
  const executablePath = argv[1] ?? '';

  if (/[\\/]_npx[\\/]/u.test(executablePath)) {
    return true;
  }

  const npmExecPath = env.npm_execpath ?? '';

  if (/npx(?:-cli)?\.js$/u.test(npmExecPath) || /[\\/]npx[\\/]/u.test(npmExecPath)) {
    return true;
  }

  const npmCommand = env.npm_command ?? '';

  return npmCommand === 'exec' || npmCommand === 'npx';
}

export function isLikelySourceExecution(argv: string[]): boolean {
  const executablePath = argv[1] ?? '';
  return /\.[cm]?tsx?$/iu.test(executablePath);
}

/* v8 ignore next -- Vitest uses a fake starter; the dist e2e covers the real spawn. */
function spawnBackgroundRefresh(request: BackgroundRefreshRequest): void {
  const entryPath = process.argv[1];

  if (!entryPath) {
    return;
  }

  // The same CLI entry, told by the env var to refresh the cache and exit. Detached and
  // unref'd, so this process exits as soon as its own command is done.
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [UPDATE_CHECK_BACKGROUND_REFRESH_ENV_VAR]: JSON.stringify(request) },
  });
  child.on('error', () => undefined);
  child.unref();
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBackgroundRefreshRequest(
  env: NodeJS.ProcessEnv,
): BackgroundRefreshRequest | undefined {
  const rawRequest = env[UPDATE_CHECK_BACKGROUND_REFRESH_ENV_VAR];

  if (!rawRequest) {
    return undefined;
  }

  let record: Record<string, unknown> | undefined;

  try {
    record = asRecord(JSON.parse(rawRequest));
  } catch {
    return undefined;
  }

  if (typeof record?.packageName !== 'string' || typeof record.cacheFilePath !== 'string') {
    return undefined;
  }

  return {
    packageName: record.packageName,
    cacheFilePath: record.cacheFilePath,
    cacheTtlMs: toOptionalNumber(record.cacheTtlMs),
    fetchTimeoutMs: toOptionalNumber(record.fetchTimeoutMs),
  };
}

/** The detached refresh process's whole job; `resolveLatestVersion` never throws. */
export async function runBackgroundRefresh(
  request: BackgroundRefreshRequest,
  options: Pick<ResolveLatestVersionOptions, 'fetchImpl' | 'now'> = {},
): Promise<void> {
  await resolveLatestVersion({ ...request, ...options });
}

function toResolveLatestVersionOptions(
  options: UpdateNotifierOptions,
  env: NodeJS.ProcessEnv,
): ResolveLatestVersionOptions & { cacheFilePath: string } {
  const baseCacheFilePath = options.cacheFilePath ?? getDefaultUpdateCheckCachePath();
  const scopedCacheFilePath = getSessionScopedCachePath(baseCacheFilePath, env);

  return {
    packageName: options.packageName,
    cacheFilePath: scopedCacheFilePath,
    cacheTtlMs: options.cacheTtlMs,
    fetchTimeoutMs: options.fetchTimeoutMs,
    fetchImpl: options.fetchImpl,
    now: options.now,
    signal: options.signal,
  };
}

export async function waitForUpdateHintBeforeExit(
  updateHintPromise: Promise<string | undefined>,
  abortController: AbortController,
  graceMs = UPDATE_HINT_EXIT_GRACE_MS,
): Promise<string | undefined> {
  const timer = setTimeout(() => {
    abortController.abort();
  }, graceMs);
  timer.unref();

  try {
    return await updateHintPromise;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdates(options: UpdateNotifierOptions): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;

  if (options.skipCheck) {
    return undefined;
  }

  if (isTruthyEnvFlag(env[UPDATE_CHECK_SKIP_ENV_VAR])) {
    return undefined;
  }

  if (shouldSkipUpdateCheckForArgv(argv)) {
    return undefined;
  }

  if (isLikelyNpxExecution(argv, env)) {
    return undefined;
  }

  if (isLikelySourceExecution(argv)) {
    return undefined;
  }

  try {
    // resolveLatestVersion serves a fresh cache hit without any network call,
    // and only performs a bounded fetch (fetchTimeoutMs, default 1s) when the
    // cache is missing or stale. Doing this on every run keeps the update
    // hint consistent across commands: a stale cache no longer silently
    // skips the hint for the run that triggers the refresh.
    const resolveOptions = toResolveLatestVersionOptions(options, env);
    const latestVersion = await resolveLatestVersion(resolveOptions);

    // The exit grace aborted the check, usually a registry fetch slower than a short
    // command. Refresh the cache from a detached process instead, so the next run reads a
    // fresh cache rather than paying the grace again. CI runs leave no process behind.
    if (options.signal?.aborted) {
      if (
        !isTruthyEnvFlag(env.CI) &&
        (await claimBackgroundRefresh(
          resolveOptions.cacheFilePath,
          options.cacheTtlMs,
          options.now,
        ))
      ) {
        (options.startBackgroundRefresh ?? spawnBackgroundRefresh)({
          packageName: options.packageName,
          cacheFilePath: resolveOptions.cacheFilePath,
          cacheTtlMs: options.cacheTtlMs,
          fetchTimeoutMs: options.fetchTimeoutMs,
        });
      }

      return undefined;
    }

    if (!latestVersion || !shouldOfferUpdate(options.currentVersion, latestVersion)) {
      return undefined;
    }

    return `Update available for ${options.packageName}: ${options.currentVersion} → ${latestVersion}. Run "npm install -g ${options.packageName}@latest" to update.`;
  } catch {
    return undefined;
  }
}
