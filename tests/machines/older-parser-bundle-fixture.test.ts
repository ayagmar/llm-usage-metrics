import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { loadMachineUsage } from '../../src/machines/load-machine-usage.js';
import { openMachineCache, recordMachineSyncFailure } from '../../src/machines/machine-cache.js';
import { closeEventStore } from '../../src/persistence/event-store.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

// A machine bundle whose events an older codex parser made (KI-3): same session and
// timestamps as the local file, a different token split.
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

async function syncAndReport(rewrite: (bundle: string) => string) {
  const { spawnSsh } = createInProcessRemote({
    configPath: path.join(tempRoot, 'remote', 'config.toml'),
    eventStorePath: path.join(tempRoot, 'remote', 'events.db'),
    rewrite,
  });
  const outcome = await syncMachine('laptop', { ssh: 'me@laptop' }, { spawnSsh, full: true });
  expect(outcome.ok).toBe(true);

  return buildUsageData(
    'monthly',
    { timezone: 'UTC', sync: false, pricingOffline: true },
    { spawnSsh, now: () => FIXED_NOW },
  );
}

describe('machine bundle from an older parser version', () => {
  it('counts each request once and warns that the machines parse codex differently', async () => {
    const usageData = await syncAndReport(() => bundleText);

    expect(usageData.events.map((event) => event.machine ?? 'local')).toEqual(['local', 'local']);
    expect(usageData.diagnostics.warnings).toContainEqual(
      expect.stringMatching(
        /^laptop parses with other parser versions \(codex n2\.p1 there, n\d+\.p\d+ on this machine\): left out 2 event\(s\) .*; update llm-usage on both machines$/,
      ),
    );
  });

  it('matches on timestamp alone, since a newer parser can resolve another model', async () => {
    const renamed = bundleText.replaceAll('"model":"gpt-5.2-codex"', '"model":"gpt-5.2-codex-max"');
    expect(renamed).not.toBe(bundleText);

    const usageData = await syncAndReport(() => renamed);

    expect(usageData.events).toHaveLength(2);
    expect(usageData.events.map((event) => event.machine ?? 'local')).toEqual(['local', 'local']);
  });

  it('notes rather than warns about a disabled machine parsing differently', async () => {
    const usageData = await syncAndReport(() => bundleText);
    const usage = await loadMachineUsage({
      names: ['laptop'],
      disabledNames: new Set(['laptop']),
      servedEvents: usageData.events,
      adapters: [{ id: 'codex', parserVersion: 2 }],
    });

    expect(usage.events).toEqual([]);
    expect(usage.warnings).toEqual([]);
    expect(usage.notes).toEqual([
      expect.stringMatching(/^laptop parses with other parser versions \(codex n2\.p1 there, /),
    ]);
  });

  // Runs after a sync that recorded versions, so an older export must clear them.
  it('keeps the hash merge, with a note, for an export that records no parser versions', async () => {
    const usageData = await syncAndReport(() =>
      bundleText.replace(',"parserVersions":{"codex":"n2.p1"}', ''),
    );
    const machines = usageData.events.map((event) => event.machine ?? 'local');

    // The bundle's events hash differently (cache reads folded into input), so without
    // versions to compare the merge keeps both copies of each request.
    expect(usageData.events).toHaveLength(4);
    expect(machines.sort()).toEqual(['laptop', 'laptop', 'local', 'local']);
    expect(usageData.events.every((event) => event.sessionId === 'codex-e2e-session')).toBe(true);
    expect(usageData.diagnostics.notes).toContain(
      'sync laptop after updating llm-usage on it to record its parser versions',
    );
    expect(usageData.diagnostics.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining('parser versions')]),
    );
  });

  it('asks a machine that never synced for nothing about parser versions', async () => {
    const cache = await openMachineCache('desk');
    recordMachineSyncFailure(cache, 'ssh: connect to host desk: Connection refused', 0);
    closeEventStore(cache);

    const usage = await loadMachineUsage({
      names: ['desk'],
      servedEvents: [],
      adapters: [{ id: 'codex', parserVersion: 2 }],
    });

    expect(usage.notes).toEqual([]);
  });
});
