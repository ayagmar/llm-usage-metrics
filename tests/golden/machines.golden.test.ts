import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildSummaryReport } from '../../src/cli/run-summary-report.js';
import { buildUsageReport } from '../../src/cli/run-usage-report.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';
import {
  copyFixtures,
  expectGolden,
  FIXED_GOLDENS,
  FIXED_NOW,
  fixedNow,
  freezeDate,
  normalizePaths,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`machine goldens (${WINDOWS_SKIP_REASON})`, () => {
  const environment = useIsolatedEnvironment();
  const pricing = useBundledPricingOnly();
  useGoldenUpdateCheck([
    FIXED_GOLDENS.machinesUsageMonthlyByMachine,
    FIXED_GOLDENS.machinesSummary,
  ]);
  // Reports read the synced cache only; a sync attempt would go through this stand-in.
  let remote: ReturnType<typeof createInProcessRemote>;

  beforeAll(async () => {
    freezeDate();
    // Both machines read the pinned fixture copy, never the checkout (see copyFixtures).
    const { e2eRoot } = await copyFixtures(environment.rootDir);
    const piFixtureDir = path.join(e2eRoot, 'pi');
    const codexFixtureDir = path.join(e2eRoot, 'codex');
    const localDir = path.join(environment.rootDir, 'local');
    const remoteDir = path.join(environment.rootDir, 'remote');
    await mkdir(localDir);

    // The laptop has a copy of this machine's pi session, which the merge counts once,
    // and a codex session of its own under another path, which it adds.
    await cp(piFixtureDir, path.join(remoteDir, 'pi'), { recursive: true });
    await mkdir(path.join(remoteDir, 'codex', 'laptop'), { recursive: true });
    await writeFile(
      path.join(remoteDir, 'codex', 'laptop', 'laptop-session.jsonl'),
      (await readFile(path.join(codexFixtureDir, 'session.jsonl'), 'utf8')).replace(
        '"id":"codex-e2e-session"',
        '"id":"codex-laptop-session"',
      ),
    );
    await writeFile(
      path.join(remoteDir, 'config.toml'),
      'sources = ["pi", "codex"]\n[sourceDirs]\npi = "pi"\ncodex = "codex"\n',
    );
    await writeFile(
      path.join(localDir, 'config.toml'),
      [
        'sources = ["pi", "codex"]',
        '[sourceDirs]',
        `pi = ${JSON.stringify(piFixtureDir)}`,
        `codex = ${JSON.stringify(codexFixtureDir)}`,
        '[machines.laptop]',
        'ssh = "me@laptop"',
        '',
      ].join('\n'),
    );

    vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(localDir, 'config.toml'));
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(localDir, 'events.db'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    remote = createInProcessRemote({
      configPath: path.join(remoteDir, 'config.toml'),
      eventStorePath: path.join(remoteDir, 'events.db'),
    });
    const outcome = await syncMachine(
      'laptop',
      { ssh: 'me@laptop' },
      { spawnSsh: remote.spawnSsh, now: () => FIXED_NOW.getTime() },
    );
    expect(outcome.ok).toBe(true);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const reportOptions = {
    timezone: 'UTC',
    pricingOffline: true,
    sync: false,
    json: true,
  } as const;

  it('freezes machines/usage-monthly-by-machine.json', async () => {
    const output = await buildUsageReport('monthly', { ...reportOptions, byMachine: true });

    expect(output).toContain('"machine": "laptop"');

    await expectGolden(
      FIXED_GOLDENS.machinesUsageMonthlyByMachine,
      normalizePaths(output, environment.rootDir),
    );
  });

  it('freezes machines/summary.json', async () => {
    const output = await buildSummaryReport(reportOptions, {
      spawnSsh: remote.spawnSsh,
      now: fixedNow,
    });

    await expectGolden(FIXED_GOLDENS.machinesSummary, normalizePaths(output, environment.rootDir));
  });

  it('syncs once, in the priming refresh, and never reaches the network', () => {
    expect(remote.calls.filter((args) => args.at(-1)?.includes('machine export'))).toHaveLength(1);
    expect(pricing.fetch).not.toHaveBeenCalled();
  });
});
