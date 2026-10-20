import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { writeClaudeForkSession, writePiParentAndFork } from '../helpers/fork-fixtures.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const execFileAsync = promisify(execFile);
const distCliPath = path.resolve('dist/index.js');
const distBinPath = path.resolve('dist/bin.js');
const piDir = path.resolve('tests/fixtures/e2e/pi');
const codexDir = path.resolve('tests/fixtures/e2e/codex');
const largeCodexDir = path.resolve('tests/fixtures/e2e-large/codex');
const geminiDir = path.resolve('tests/fixtures/e2e/gemini');
const droidDir = path.resolve('tests/fixtures/e2e/droid');
const claudeDir = path.resolve('tests/fixtures/e2e/claude');
const openclawDir = path.resolve('tests/fixtures/e2e/openclaw');
const sourceList = 'pi,codex,gemini,droid,openclaw,claude';
const expectedDirectorySourceTokens = 1_200;

type UsageJsonRow = {
  rowType: string;
  periodKey: string;
  totalTokens: number;
};

type ExecFileFailure = Error & {
  code?: number | string;
  stderr?: string;
};

function createSmokeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    LLM_USAGE_EVENT_STORE: '0',
  };
}

// Local `pnpm run test` can run before `pnpm run build`; CI's main-test job builds first.
if (!existsSync(distCliPath)) {
  // vitest swallows module-scope console output from fully skipped files.
  process.stderr.write(
    'dist cli e2e skipped: dist/index.js not built (run pnpm run build or pnpm run verify:full)\n',
  );
}

describe.skipIf(!existsSync(distCliPath))('dist CLI e2e', () => {
  // Installs run dist/bin.js, which enables Node's compile cache and then loads index.js.
  it('runs the same CLI through the published bin loader', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
    };
    expect(Object.values(packageJson.bin)).toEqual(['dist/bin.js', 'dist/bin.js']);
    expect(packageJson.files).toEqual(expect.arrayContaining(['dist/bin.js', 'dist/index.js']));

    const args = [
      'monthly',
      '--json',
      '--timezone',
      'UTC',
      '--source',
      'pi,codex',
      '--pi-dir',
      piDir,
      '--codex-dir',
      codexDir,
      '--pricing-offline',
    ];
    const options = { encoding: 'utf8' as const, env: createSmokeEnv(), maxBuffer: 1024 * 1024 };
    const viaBin = await execFileAsync(process.execPath, [distBinPath, ...args], options);
    const viaIndex = await execFileAsync(process.execPath, [distCliPath, ...args], options);

    expect(viaBin.stdout).toBe(viaIndex.stdout);
    expect(JSON.parse(viaBin.stdout)).toMatchObject({ report: 'usage' });
  });

  // npm only warns about `engines`, so an unsupported Node must still get a clear message.
  it.each(['20.11.0', '22.15.1', '23.11.0'])(
    'names the supported Node versions on Node %s',
    async (version) => {
      const fakeVersion = `Object.defineProperty(process.versions, 'node', { value: '${version}' });`;
      const failure = (await execFileAsync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(fakeVersion)}`,
          distBinPath,
          '--version',
        ],
        { encoding: 'utf8', env: createSmokeEnv() },
      ).catch((error: unknown) => error)) as ExecFileFailure;

      expect(failure.code).toBe(1);
      expect(failure.stderr).toBe(
        `llm-usage requires Node.js 22.16+ or 24+; this is Node.js ${version}.\n`,
      );
    },
  );

  it('prints data-only monthly JSON from the built CLI', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        distCliPath,
        'monthly',
        '--json',
        '--verbose',
        '--timezone',
        'UTC',
        '--source',
        sourceList,
        '--pi-dir',
        piDir,
        '--codex-dir',
        codexDir,
        '--gemini-dir',
        geminiDir,
        '--droid-dir',
        droidDir,
        '--claude-dir',
        claudeDir,
        '--openclaw-dir',
        openclawDir,
        '--pricing-offline',
      ],
      {
        encoding: 'utf8',
        env: createSmokeEnv(),
        maxBuffer: 1024 * 1024,
      },
    );

    const parsed = JSON.parse(stdout) as {
      schemaVersion: number;
      report: string;
      data: UsageJsonRow[];
    };

    expect(parsed).toMatchObject({ schemaVersion: 1, report: 'usage' });
    const rows = parsed.data;
    const grandTotalRow = rows.find(
      (row) => row.rowType === 'grand_total' && row.periodKey === 'ALL',
    );

    expect(grandTotalRow?.totalTokens).toBe(expectedDirectorySourceTokens);
    expect(stderr).toMatch(/Scanned \d+ files?/u);
  });

  it('suppresses informational stderr with --quiet without changing JSON output', async () => {
    const args = [
      distCliPath,
      'daily',
      '--json',
      '--timezone',
      'UTC',
      '--source',
      sourceList,
      '--pi-dir',
      piDir,
      '--codex-dir',
      codexDir,
      '--gemini-dir',
      geminiDir,
      '--droid-dir',
      droidDir,
      '--claude-dir',
      claudeDir,
      '--openclaw-dir',
      openclawDir,
      '--pricing-offline',
    ];
    const plain = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      env: createSmokeEnv(),
      maxBuffer: 1024 * 1024,
    });
    const quiet = await execFileAsync(process.execPath, [...args, '--quiet'], {
      encoding: 'utf8',
      env: createSmokeEnv(),
      maxBuffer: 1024 * 1024,
    });

    expect(quiet.stdout).toBe(plain.stdout);
    expect(plain.stderr).toContain('ℹ');
    expect(quiet.stderr).not.toContain('ℹ');
    expect(quiet.stderr.split('\n').filter((line) => line.includes('⚠'))).toEqual(
      plain.stderr.split('\n').filter((line) => line.includes('⚠')),
    );
  });

  it('prints help even when the user config is malformed', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dist-cli-bad-config-help-'));
    const configPath = path.join(tempDir, 'config.toml');
    await writeFile(configPath, 'not == valid toml', 'utf8');

    try {
      const { stdout } = await execFileAsync(process.execPath, [distCliPath, '--help'], {
        encoding: 'utf8',
        env: { ...createSmokeEnv(), LLM_USAGE_CONFIG_PATH: configPath },
      });

      expect(stdout).toContain('Usage:');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('matches built-binary codex output with worker parsing enabled', async () => {
    const args = [
      distCliPath,
      'daily',
      '--json',
      '--timezone',
      'UTC',
      '--source',
      'codex',
      '--codex-dir',
      largeCodexDir,
      '--pricing-offline',
      // Env override details are --verbose output.
      '--verbose',
    ];
    const workersOn = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        ...createSmokeEnv(),
        LLM_USAGE_PARSE_WORKERS: '2',
        LLM_USAGE_PARSE_WORKER_MIN_BYTES: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    const workersOff = await execFileAsync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        ...createSmokeEnv(),
        LLM_USAGE_PARSE_WORKERS: '0',
        LLM_USAGE_PARSE_WORKER_MIN_BYTES: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });

    expect(workersOn.stdout).toBe(workersOff.stdout);
    expect(JSON.parse(workersOn.stdout)).toEqual(JSON.parse(workersOff.stdout));
    expect(workersOn.stderr).toContain('LLM_USAGE_PARSE_WORKERS=2');
    expect(workersOff.stderr).toContain('LLM_USAGE_PARSE_WORKERS=0');
  }, 15_000);

  it('matches built-binary claude and pi output with every file parsed on workers', async () => {
    const tempDir = await mkdtemp(path.join(canonicalTmpdir(), 'dist-cli-fork-workers-'));

    try {
      const projectsDir = path.join(tempDir, 'claude-projects');
      const subagentsDir = await writeClaudeForkSession(path.join(projectsDir, 'repo'));
      const piParentDir = path.join(tempDir, 'pi-a');
      const piForkDir = path.join(tempDir, 'pi-b');
      await writePiParentAndFork(piParentDir, piForkDir);

      const runDaily = async (claudeDir: string, workers: string) => {
        const args = [
          distCliPath,
          'daily',
          '--json',
          '--timezone',
          'UTC',
          '--source',
          'claude,pi',
          '--claude-dir',
          claudeDir,
          '--pi-dir',
          piParentDir,
          '--pi-dir',
          piForkDir,
          '--since',
          '2026-01-01',
          '--pricing-offline',
          '--verbose',
        ];
        const { stdout, stderr } = await execFileAsync(process.execPath, args, {
          encoding: 'utf8',
          env: {
            ...createSmokeEnv(),
            HOME: tempDir,
            LLM_USAGE_PARSE_WORKERS: workers,
            LLM_USAGE_PARSE_WORKER_MIN_BYTES: '0',
            LLM_USAGE_PROFILE_RUNTIME: '1',
          },
          maxBuffer: 1024 * 1024,
          timeout: 10_000,
        });
        // Profile lines carry timings; the skipped-row diagnostics must match exactly.
        const diagnostics = stderr
          .split('\n')
          .filter((line) => line.toLowerCase().includes('skipped'))
          .join('\n');
        return { stdout, stderr, diagnostics };
      };

      const reports: string[] = [];

      // The fork's parent inside, then outside, the scanned Claude directory.
      for (const claudeDir of [projectsDir, subagentsDir]) {
        const workersOn = await runDaily(claudeDir, '2');
        const workersOff = await runDaily(claudeDir, '0');

        expect(workersOn.stdout).toBe(workersOff.stdout);
        expect(workersOn.diagnostics).toBe(workersOff.diagnostics);
        expect(workersOn.diagnostics).not.toBe('');
        expect(workersOn.stderr).toMatch(/source claude:.*parseWorkers=engaged/);
        expect(workersOn.stderr).toMatch(/source pi:.*parseWorkers=engaged/);
        expect(workersOff.stderr).not.toContain('parseWorkers=engaged');
        reports.push(workersOn.stdout);
      }

      // Counting the parent drops the fork's replayed row.
      expect(reports[0]).not.toBe(reports[1]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails a real command with an actionable malformed-config error', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dist-cli-bad-config-run-'));
    const configPath = path.join(tempDir, 'config.toml');
    await writeFile(configPath, 'not == valid toml', 'utf8');

    let exitCode: number | string | undefined;
    let stderr = '';

    try {
      await execFileAsync(process.execPath, [distCliPath, 'monthly', '--pricing-offline'], {
        encoding: 'utf8',
        env: { ...createSmokeEnv(), LLM_USAGE_CONFIG_PATH: configPath },
      });
    } catch (error) {
      exitCode = (error as ExecFileFailure).code;
      stderr = (error as ExecFileFailure).stderr ?? '';
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`error: Failed to parse config file ${configPath}`);
  });

  it('exits nonzero for unknown options', async () => {
    let exitCode: number | string | undefined;

    try {
      await execFileAsync(process.execPath, [distCliPath, 'monthly', '--not-a-flag'], {
        encoding: 'utf8',
        env: createSmokeEnv(),
      });
    } catch (error) {
      exitCode = (error as ExecFileFailure).code;
    }

    expect(exitCode).toBeDefined();
    expect(exitCode).not.toBe(0);
  });

  it('refreshes a stale update-check cache from a detached process after a short command', async () => {
    const tempDir = await mkdtemp(path.join(canonicalTmpdir(), 'dist-update-refresh-'));

    try {
      const cacheDir = path.join(tempDir, 'cache');
      const cacheFilePath = path.join(cacheDir, 'llm-usage-metrics', 'update-check.json');
      await mkdir(path.dirname(cacheFilePath), { recursive: true });
      await writeFile(cacheFilePath, JSON.stringify({ checkedAt: 1, latestVersion: '0.0.1' }));

      // A fake npm registry. The command's own request does not answer before it exits, as
      // when the registry is slower than the command; only the detached refresh process gets
      // a version.
      const registryPath = path.join(tempDir, 'fake-registry.mjs');
      await writeFile(
        registryPath,
        `globalThis.fetch = (url, init) => {
  if (process.env.LLM_USAGE_UPDATE_CHECK_REFRESH) {
    return Promise.resolve(new Response(JSON.stringify({ version: '99.0.0' })));
  }
  return new Promise((_resolve, reject) => {
    // An open request keeps the process alive, as a real socket does.
    const pending = setTimeout(() => reject(new Error('fake registry timed out')), 60_000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(pending);
      reject(init.signal.reason);
    }, { once: true });
  });
};
`,
      );

      const env: NodeJS.ProcessEnv = {
        ...createSmokeEnv(),
        XDG_CACHE_HOME: cacheDir,
        NODE_OPTIONS: `--import=${pathToFileURL(registryPath).href}`,
      };
      // Each turns off the check or its background refresh: the opt-out, CI, and npx (pnpm sets
      // npm_command).
      delete env.LLM_USAGE_SKIP_UPDATE_CHECK;
      delete env.CI;
      delete env.npm_command;
      delete env.npm_execpath;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          distCliPath,
          'monthly',
          '--json',
          '--source',
          'codex',
          '--codex-dir',
          codexDir,
          '--pricing-offline',
        ],
        { encoding: 'utf8', env },
      );
      expect(JSON.parse(stdout)).toMatchObject({ report: 'usage' });

      let cachedVersion: string | undefined;

      for (let attempt = 0; attempt < 100 && cachedVersion !== '99.0.0'; attempt += 1) {
        await delay(100);
        cachedVersion = (
          JSON.parse(await readFile(cacheFilePath, 'utf8')) as { latestVersion: string }
        ).latestVersion;
      }

      expect(cachedVersion).toBe('99.0.0');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
