import {
  getDefaultUpdateCheckCachePath,
  getSessionScopedCachePath,
  resolveLatestVersion,
  type ResolveLatestVersionOptions,
} from './update-cache-repository.js';
import {
  isInteractiveSession,
  runInteractiveInstallAndRestart,
  type CommandRunner,
  type ConfirmInstall,
  type Notify,
} from './update-install-runner.js';
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
export {
  defaultConfirmInstall,
  defaultNotify,
  isInteractiveSession,
  runCommandWithSpawn,
  runInteractiveInstallAndRestart,
  type CommandRunner,
  type ConfirmInstall,
  type Notify,
  type RunInteractiveInstallAndRestartOptions,
  type UpdateInstallRestartResult,
} from './update-install-runner.js';

export const UPDATE_CHECK_SKIP_ENV_VAR = 'LLM_USAGE_SKIP_UPDATE_CHECK';

export type UpdateNotifierOptions = {
  packageName: string;
  currentVersion: string;
  cacheFilePath?: string;
  cacheTtlMs?: number;
  fetchTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  confirmInstall?: ConfirmInstall;
  runCommand?: CommandRunner;
  notify?: Notify;
};

export type UpdateNotifierResult = {
  continueExecution: boolean;
  exitCode?: number;
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

export async function checkForUpdatesAndMaybeRestart(
  options: UpdateNotifierOptions,
): Promise<UpdateNotifierResult> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;

  if (isTruthyEnvFlag(env[UPDATE_CHECK_SKIP_ENV_VAR])) {
    return { continueExecution: true };
  }

  if (shouldSkipUpdateCheckForArgv(argv)) {
    return { continueExecution: true };
  }

  if (isLikelyNpxExecution(argv, env)) {
    return { continueExecution: true };
  }

  if (isLikelySourceExecution(argv)) {
    return { continueExecution: true };
  }

  try {
    // resolveLatestVersion serves a fresh cache hit without any network call,
    // and only performs a bounded fetch (fetchTimeoutMs, default 1s) when the
    // cache is missing or stale. Doing this on every run keeps the update
    // prompt consistent across commands: a stale cache no longer silently
    // skips the prompt for the run that triggers the refresh.
    const latestVersion = await resolveLatestVersion(toResolveLatestVersionOptions(options, env));

    if (!latestVersion || !shouldOfferUpdate(options.currentVersion, latestVersion)) {
      return { continueExecution: true };
    }

    const updateMessage = `Update available for ${options.packageName}: ${options.currentVersion} → ${latestVersion}.`;
    const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
    const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY;

    if (!isInteractiveSession({ env, stdinIsTTY, stdoutIsTTY })) {
      (options.notify ?? console.error)(
        `${updateMessage} Run "npm install -g ${options.packageName}@latest" to update.`,
      );
      return { continueExecution: true };
    }

    return await runInteractiveInstallAndRestart({
      packageName: options.packageName,
      updateMessage,
      env,
      argv,
      execPath: options.execPath,
      skipUpdateCheckEnvVar: UPDATE_CHECK_SKIP_ENV_VAR,
      confirmInstall: options.confirmInstall,
      runCommand: options.runCommand,
      notify: options.notify,
    });
  } catch {
    return { continueExecution: true };
  }
}
