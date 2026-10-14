import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

// Freezes v0.11.0 merging of a machine bundle whose events an older codex parser made
// (KI-3): same session and timestamps as the local file, a different token split.
const bundlePath = path.resolve('tests/fixtures/golden/_machines/older-parser-bundle.jsonl');
const FIXED_NOW = new Date('2026-06-21T12:00:00.000Z');

let tempRoot: string;
let bundleText: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(canonicalTmpdir(), 'older-parser-bundle-fixture-'));
  bundleText = await readFile(bundlePath, 'utf8');
  const localDir = path.join(tempRoot, 'local');
  const remoteDir = path.join(tempRoot, 'remote');

  await cp(path.resolve('tests/fixtures/e2e/codex'), path.join(localDir, 'codex'), {
    recursive: true,
  });
  await writeFile(
    path.join(localDir, 'config.toml'),
    [
      'sources = ["codex"]',
      '[sourceDirs]',
      'codex = "codex"',
      '[machines.laptop]',
      'ssh = "me@laptop"',
      '',
    ].join('\n'),
  );
  // The in-process remote runs a real export before `rewrite` replaces its output, so it
  // reads an empty codex dir instead of this machine's default paths.
  await mkdir(path.join(remoteDir, 'codex'), { recursive: true });
  await writeFile(
    path.join(remoteDir, 'config.toml'),
    'sources = ["codex"]\n[sourceDirs]\ncodex = "codex"\n',
  );

  vi.stubEnv('TZ', 'UTC');
  vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(localDir, 'config.toml'));
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(localDir, 'events.db'));
  vi.stubEnv('XDG_DATA_HOME', path.join(localDir, 'data'));
  // Inline until M0-T1 merges; then use useBundledPricingOnly() from
  // tests/helpers/offline-pricing.ts and useIsolatedEnvironment() from
  // tests/helpers/isolated-env.ts.
  vi.stubEnv('XDG_CACHE_HOME', path.join(tempRoot, 'cache'));
  vi.stubEnv('CODEX_HOME', path.join(tempRoot, 'missing-codex-home'));
  vi.stubGlobal('fetch', () => {
    throw new Error('fetch must not be called: pricing is the bundled snapshot');
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(tempRoot, { recursive: true, force: true });
});

describe('machine bundle from an older parser version', () => {
  it('counts the bundle events next to the local events of the same session', async () => {
    const { spawnSsh } = createInProcessRemote({
      configPath: path.join(tempRoot, 'remote', 'config.toml'),
      eventStorePath: path.join(tempRoot, 'remote', 'events.db'),
      rewrite: () => bundleText,
    });
    const outcome = await syncMachine('laptop', { ssh: 'me@laptop' }, { spawnSsh });
    expect(outcome.ok).toBe(true);

    const usageData = await buildUsageData(
      'monthly',
      { timezone: 'UTC', sync: false, pricingOffline: true },
      { spawnSsh, now: () => FIXED_NOW },
    );
    const machines = usageData.events.map((event) => event.machine ?? 'local');

    // KNOWN ISSUE KI-3: expected 2 once per-source parser versions are checked. The
    // bundle's events hash differently (cache reads folded into input), so the merge
    // keeps both copies of each request.
    expect(usageData.events).toHaveLength(4);
    expect(machines.sort()).toEqual(['laptop', 'laptop', 'local', 'local']);
    expect(usageData.events.every((event) => event.sessionId === 'codex-e2e-session')).toBe(true);
  });
});
