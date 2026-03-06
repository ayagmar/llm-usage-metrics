import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkForUpdatesAndMaybeRestart,
  compareVersions,
  isCacheFresh,
  isLikelyNpxExecution,
  isLikelySourceExecution,
  refreshUpdateCheckCache,
  resolveLatestVersion,
  shouldOfferUpdate,
  shouldSkipUpdateCheckForArgv,
  UPDATE_CHECK_REFRESH_ENV_VAR,
  type CommandRunner,
} from '../../src/update/update-notifier.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

async function createTempCachePath(prefix: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return path.join(tempDir, 'update-check.json');
}

describe('update-notifier', () => {
  it('compares semantic versions and applies prerelease policy', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-alpha.1', '1.2.3-alpha.2')).toBeLessThan(0);

    expect(shouldOfferUpdate('1.2.3', '1.3.0-beta.1')).toBe(false);
    expect(shouldOfferUpdate('1.2.3-beta.1', '1.2.3')).toBe(true);
  });

  it('detects argv shapes where update check should be skipped', () => {
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js'])).toBe(false);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', '--help'])).toBe(true);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'help'])).toBe(true);
    expect(
      shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'ts-node/register', 'help']),
    ).toBe(true);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', '--version'])).toBe(true);
    expect(
      shouldSkipUpdateCheckForArgv([
        'node',
        '/app/dist/index.js',
        'custom-bootstrap.js',
        'version',
      ]),
    ).toBe(true);
    expect(
      shouldSkipUpdateCheckForArgv([
        'node',
        '/app/dist/index.js',
        'daily',
        '--provider',
        'version',
      ]),
    ).toBe(false);
    expect(
      shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'efficiency', 'daily']),
    ).toBe(false);
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'efficiency', 'help'])).toBe(
      false,
    );
    expect(shouldSkipUpdateCheckForArgv(['node', '/app/dist/index.js', 'optimize', 'help'])).toBe(
      false,
    );
  });

  it('uses a fresh cache entry and skips network calls', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-fresh-');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 1_000,
        latestVersion: '9.9.9',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for fresh cache');
    });

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: fetchSpy,
      now: () => nowValue,
    });

    expect(latestVersion).toBe('9.9.9');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(isCacheFresh({ checkedAt: nowValue - 1_000 }, 5_000, () => nowValue)).toBe(true);
    expect(isCacheFresh({ checkedAt: nowValue + 100 }, 5_000, () => nowValue)).toBe(false);
  });

  it('ignores malformed cached versions and refreshes from registry', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-invalid-version-');

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: 1_000_000,
        latestVersion: 'not-a-semver',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ version: '0.9.0' }), { status: 200 }),
    );

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: fetchSpy,
      now: () => 1_000_100,
    });

    expect(latestVersion).toBe('0.9.0');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('uses stale cache when network check fails without refreshing checkedAt', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-stale-');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 10_000,
        latestVersion: '9.9.9',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      throw new Error('timeout');
    });

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: fetchSpy,
      now: () => nowValue,
      sleep: async () => undefined,
    });

    expect(latestVersion).toBe('9.9.9');
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const updatedCache = JSON.parse(await readFile(cacheFilePath, 'utf8')) as {
      checkedAt: number;
      latestVersion: string;
    };

    expect(updatedCache).toEqual({
      checkedAt: nowValue - 10_000,
      latestVersion: '9.9.9',
    });
  });

  it('uses stale cache when npm registry responds without version payload', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-invalid-response-');
    const nowValue = 2_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 10_000,
        latestVersion: '0.3.0',
      }),
      'utf8',
    );

    const latestVersion = await resolveLatestVersion({
      packageName: 'llm-usage-metrics',
      cacheFilePath,
      cacheTtlMs: 5_000,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })),
      now: () => nowValue,
    });

    expect(latestVersion).toBe('0.3.0');
  });

  it('supports session-scoped update cache files', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-session-');
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
    );

    const baseNow = 5_000_000;
    const now = () => baseNow;

    await refreshUpdateCheckCache({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      env: {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
        LLM_USAGE_UPDATE_CACHE_SESSION_KEY: 'kitty/tab-1',
      },
      now,
      fetchImpl: fetchSpy,
    });

    await refreshUpdateCheckCache({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      env: {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
        LLM_USAGE_UPDATE_CACHE_SESSION_KEY: 'kitty/tab-1',
      },
      now,
      fetchImpl: fetchSpy,
    });

    const parsedCachePath = path.parse(cacheFilePath);
    const sessionScopedCachePath = path.join(
      parsedCachePath.dir,
      `${parsedCachePath.name}.kitty_tab-1${parsedCachePath.ext}`,
    );

    const sessionCachePayload = JSON.parse(await readFile(sessionScopedCachePath, 'utf8')) as {
      checkedAt: number;
      latestVersion: string;
    };

    expect(sessionCachePayload).toEqual({
      checkedAt: baseNow,
      latestVersion: '0.2.0',
    });
    await expect(readFile(cacheFilePath, 'utf8')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('falls back to parent pid session key when custom env session key is blank', async () => {
    const cacheFilePath = await createTempCachePath('update-cache-session-blank-key-');
    const nowValue = 6_000_000;

    await refreshUpdateCheckCache({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      env: {
        LLM_USAGE_UPDATE_CACHE_SCOPE: 'session',
        LLM_USAGE_UPDATE_CACHE_SESSION_KEY: '   ',
      },
      now: () => nowValue,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
      ),
    });

    const parsedCachePath = path.parse(cacheFilePath);
    const sessionScopedCachePath = path.join(
      parsedCachePath.dir,
      `${parsedCachePath.name}.ppid-${process.ppid}${parsedCachePath.ext}`,
    );

    const sessionCachePayload = JSON.parse(await readFile(sessionScopedCachePath, 'utf8')) as {
      checkedAt: number;
      latestVersion: string;
    };

    expect(sessionCachePayload).toEqual({
      checkedAt: nowValue,
      latestVersion: '0.2.0',
    });
    await expect(readFile(cacheFilePath, 'utf8')).rejects.toThrow();
  });

  it('skips update checks for npx execution', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for npx execution');
    });
    const notify = vi.fn();

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      argv: ['/usr/bin/node', '/tmp/_npx/123/node_modules/llm-usage/dist/index.js', 'daily'],
      env: {},
      fetchImpl: fetchSpy,
      notify,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('detects npx execution from npm_execpath hints', () => {
    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'], {
        npm_execpath: '/usr/lib/node_modules/npm/bin/npx-cli.js',
      }),
    ).toBe(true);

    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'], {
        npm_execpath: '/usr/lib/node_modules/pnpm/bin/pnpm.js',
      }),
    ).toBe(false);
    expect(
      isLikelyNpxExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'], {
        npm_command: 'npx',
      }),
    ).toBe(true);
  });

  it('detects local source execution entrypoints', () => {
    expect(isLikelySourceExecution(['/usr/bin/pnpm', '/app/src/cli/index.ts', 'daily'])).toBe(true);
    expect(isLikelySourceExecution(['/usr/bin/node', '/app/src/cli/index.mts', 'daily'])).toBe(
      true,
    );
    expect(isLikelySourceExecution(['/usr/bin/node', '/app/dist/index.js', 'daily'])).toBe(false);
  });

  it('skips update checks for local source execution', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for local source execution');
    });
    const notify = vi.fn();

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.11',
      argv: ['/usr/bin/pnpm', '/app/src/cli/index.ts', 'monthly'],
      env: {},
      fetchImpl: fetchSpy,
      notify,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips update checks for help/version invocations', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when check is skipped');
    });

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      argv: ['/usr/bin/node', '/app/dist/index.js', '--help'],
      fetchImpl: fetchSpy,
      notify: vi.fn(),
    });

    expect(result).toEqual({ continueExecution: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips update checks when skip env var is set', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when env skip flag is set');
    });

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      env: {
        LLM_USAGE_SKIP_UPDATE_CHECK: '1',
      },
      fetchImpl: fetchSpy,
      notify: vi.fn(),
    });

    expect(result).toEqual({ continueExecution: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips update checks when skip env var uses truthy string values', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called when env skip flag is set');
    });

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      env: {
        LLM_USAGE_SKIP_UPDATE_CHECK: 'true',
      },
      fetchImpl: fetchSpy,
      notify: vi.fn(),
    });

    expect(result).toEqual({ continueExecution: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('continues without notifying when the latest version is not newer', async () => {
    const cacheFilePath = await createTempCachePath('update-non-newer-');
    const notify = vi.fn();

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.2.0',
      cacheFilePath,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
      ),
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {},
      notify,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(notify).not.toHaveBeenCalled();
  });

  it('uses a fresh cached update immediately without scheduling background refresh', async () => {
    const cacheFilePath = await createTempCachePath('update-fresh-cache-hit-');
    const nowValue = 7_000_000;
    const notify = vi.fn();
    const spawnDetachedCommand = vi.fn();
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called for fresh cache');
    });

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 500,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
      execPath: '/usr/bin/node',
      notify,
      spawnDetachedCommand,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(notify).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnDetachedCommand).not.toHaveBeenCalled();
  });

  it('schedules a detached refresh instead of blocking when no cache is available', async () => {
    const notify = vi.fn();
    const spawnDetachedCommand = vi.fn();
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called on the foreground path');
    });

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath: '/tmp/update-check.json',
      fetchImpl: fetchSpy,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily', '--json'],
      execPath: '/usr/bin/node',
      notify,
      spawnDetachedCommand,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(notify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnDetachedCommand).toHaveBeenCalledOnce();
    expect(spawnDetachedCommand).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/app/dist/index.js', 'daily', '--json'],
      {
        env: {
          PATH: '/usr/bin',
          [UPDATE_CHECK_REFRESH_ENV_VAR]: '1',
        },
        stdio: 'ignore',
      },
    );
  });

  it('does not notify from stale cache and schedules a detached refresh instead', async () => {
    const cacheFilePath = await createTempCachePath('update-stale-background-refresh-');
    const nowValue = 8_000_000;
    const notify = vi.fn();
    const spawnDetachedCommand = vi.fn();
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch should not be called on the foreground path');
    });

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 10_000,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 1_000,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily'],
      execPath: '/usr/bin/node',
      notify,
      spawnDetachedCommand,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(notify).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spawnDetachedCommand).toHaveBeenCalledOnce();
  });

  it('swallows unexpected notifier errors and continues execution', async () => {
    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      now: () => {
        throw new Error('clock unavailable');
      },
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 }),
      ),
      env: {},
      notify: vi.fn(),
    });

    expect(result).toEqual({ continueExecution: true });
  });

  it('prompts in interactive mode and respects the no-install branch', async () => {
    const cacheFilePath = await createTempCachePath('update-prompt-no-');
    const confirmInstall = vi.fn(async () => false);
    const runCommand = vi.fn<CommandRunner>();
    const nowValue = 9_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 100,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => nowValue,
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not be called for fresh cache');
      }),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      confirmInstall,
      runCommand,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(confirmInstall).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('stops restart flow when install command fails', async () => {
    const cacheFilePath = await createTempCachePath('update-install-fail-');
    const confirmInstall = vi.fn(async () => true);
    const notify = vi.fn();
    const runCommand = vi.fn<CommandRunner>().mockResolvedValueOnce(1);
    const nowValue = 10_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 100,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => nowValue,
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not be called for fresh cache');
      }),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: {},
      confirmInstall,
      runCommand,
      notify,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to install llm-usage-metrics@latest'),
    );
  });

  it('restarts with original argv and skip-update env flag after successful install', async () => {
    const cacheFilePath = await createTempCachePath('update-restart-');
    const confirmInstall = vi.fn(async () => true);
    const nowValue = 11_000_000;
    const commandCalls: Array<{
      command: string;
      args: string[];
      options?: { env?: NodeJS.ProcessEnv; stdio?: 'inherit' };
    }> = [];

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 100,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const runCommand: CommandRunner = async (command, args, commandOptions) => {
      commandCalls.push({
        command,
        args,
        options: commandOptions,
      });

      return commandCalls.length === 1 ? 0 : 23;
    };

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => nowValue,
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not be called for fresh cache');
      }),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      env: { PATH: '/usr/bin' },
      argv: ['/usr/bin/node', '/app/dist/index.js', 'daily', '--json'],
      execPath: '/usr/bin/node',
      confirmInstall,
      runCommand,
    });

    expect(result).toEqual({ continueExecution: false, exitCode: 23 });

    expect(commandCalls).toHaveLength(2);

    const installCall = commandCalls[0];
    expect(installCall.command).toMatch(/npm(?:\.cmd)?$/u);
    expect(installCall.args).toEqual(['install', '-g', 'llm-usage-metrics@latest']);

    const restartCall = commandCalls[1];
    expect(restartCall.command).toBe('/usr/bin/node');
    expect(restartCall.args).toEqual(['/app/dist/index.js', 'daily', '--json']);
    expect(restartCall.options?.stdio).toBe('inherit');
    expect(restartCall.options?.env?.PATH).toBe('/usr/bin');
    expect(restartCall.options?.env?.LLM_USAGE_SKIP_UPDATE_CHECK).toBe('1');
  });

  it('does not prompt in non-interactive mode and only prints notice', async () => {
    const cacheFilePath = await createTempCachePath('update-non-interactive-');
    const confirmInstall = vi.fn(async () => true);
    const notify = vi.fn();
    let runCommandCalled = false;
    const nowValue = 12_000_000;
    const runCommand: CommandRunner = async () => {
      runCommandCalled = true;
      return 0;
    };

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        checkedAt: nowValue - 100,
        latestVersion: '0.2.0',
      }),
      'utf8',
    );

    const result = await checkForUpdatesAndMaybeRestart({
      packageName: 'llm-usage-metrics',
      currentVersion: '0.1.0',
      cacheFilePath,
      cacheTtlMs: 5_000,
      now: () => nowValue,
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not be called for fresh cache');
      }),
      stdinIsTTY: false,
      stdoutIsTTY: false,
      env: {},
      confirmInstall,
      runCommand,
      notify,
    });

    expect(result).toEqual({ continueExecution: true });
    expect(confirmInstall).not.toHaveBeenCalled();
    expect(runCommandCalled).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
  });
});
