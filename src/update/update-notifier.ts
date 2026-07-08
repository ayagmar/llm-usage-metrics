import {
  getDefaultUpdateCheckCachePath,
  getSessionScopedCachePath,
  resolveLatestVersion,
  type ResolveLatestVersionOptions,
} from './update-cache-repository.js';
import { shouldOfferUpdate } from './version-utils.js';

export {
  UPDATE_CHECK_CACHE_SCOPE_ENV_VAR,
  UPDATE_CHECK_CACHE_SESSION_KEY_ENV_VAR,
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

export const UPDATE_CHECK_SKIP_ENV_VAR = 'LLM_USAGE_SKIP_UPDATE_CHECK';

export type UpdateNotifierOptions = {
  packageName: string;
  currentVersion: string;
  cacheFilePath?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  skipCheck?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
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
    'help',
    'version',
  ]);

  if (executableArgs.length === 0) {
    return false;
  }

  if (executableArgs.some((arg) => ['-h', '--help', '-V', '--version'].includes(arg))) {
    return true;
  }

  const firstRecognizedCommand = executableArgs.find((arg) => commandNames.has(arg));

  return firstRecognizedCommand === 'help' || firstRecognizedCommand === 'version';
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

function toResolveLatestVersionOptions(
  options: UpdateNotifierOptions,
  env: NodeJS.ProcessEnv,
): ResolveLatestVersionOptions {
  const baseCacheFilePath = options.cacheFilePath ?? getDefaultUpdateCheckCachePath();
  const scopedCacheFilePath = getSessionScopedCachePath(baseCacheFilePath, env);

  return {
    packageName: options.packageName,
    cacheFilePath: scopedCacheFilePath,
    cacheTtlMs: options.cacheTtlMs,
    fetchTimeoutMs: options.fetchTimeoutMs,
    fetchImpl: options.fetchImpl,
    now: options.now,
  };
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
    const latestVersion = await resolveLatestVersion(toResolveLatestVersionOptions(options, env));

    if (!latestVersion || !shouldOfferUpdate(options.currentVersion, latestVersion)) {
      return undefined;
    }

    return `Update available for ${options.packageName}: ${options.currentVersion} → ${latestVersion}. Run "npm install -g ${options.packageName}@latest" to update.`;
  } catch {
    return undefined;
  }
}
