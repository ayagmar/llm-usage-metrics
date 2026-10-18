import type * as ChildProcess from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConfigReport } from '../../src/cli/build-config-report.js';
import { runConfigShow } from '../../src/cli/create-config-command.js';
import type { ConfigShowCommandOptions } from '../../src/cli/usage-data-contracts.js';
import {
  closeEventStore,
  openEventStore,
  readEventStoreSummary,
} from '../../src/persistence/event-store.js';
import { DEFAULT_LITELLM_PRICING_URL } from '../../src/pricing/litellm-pricing-fetcher.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  captureJsonStdout,
  compileReportValidators,
  validateReportOutput,
} from '../helpers/report-schema-validation.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), exec: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: childProcess.spawn.mockImplementation(actual.spawn),
    execFile: childProcess.execFile.mockImplementation(actual.execFile),
    exec: childProcess.exec.mockImplementation(actual.exec),
  };
});

const isolated = useIsolatedEnvironment();
const HOUR_MS = 3_600_000;
let caseIndex = 0;
let caseDir: string;

beforeAll(() => {
  // The isolated environment leaves the cache root to HOME, unless the shell sets this.
  vi.stubEnv('XDG_CACHE_HOME', path.join(isolated.rootDir, 'home', '.cache'));
});

beforeEach(async () => {
  caseIndex += 1;
  caseDir = path.join(isolated.rootDir, `case-${caseIndex}`);
  await mkdir(caseDir);
  vi.stubEnv('LLM_USAGE_CONFIG_PATH', path.join(caseDir, 'config.toml'));
  vi.stubEnv('XDG_CACHE_HOME', path.join(caseDir, 'cache'));
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
  vi.stubEnv('GEMINI_CLI_HOME', undefined);
  vi.stubEnv('LLM_USAGE_PARSE_WORKERS', undefined);
});

async function writeConfig(toml: string): Promise<void> {
  await writeFile(path.join(caseDir, 'config.toml'), toml, 'utf8');
}

async function writePricingCache(fetchedAt: number, sourceUrl = DEFAULT_LITELLM_PRICING_URL) {
  const cacheDir = path.join(caseDir, 'cache', 'llm-usage-metrics');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    path.join(cacheDir, 'litellm-pricing-cache.json'),
    JSON.stringify({
      formatVersion: 3,
      fetchedAt,
      sourceUrl,
      pricingByModel: { 'test-model': { inputPer1MUsd: 1, outputPer1MUsd: 2 } },
    }),
  );
}

const noFetch = vi.fn<typeof fetch>(() => Promise.reject(new Error('config show must not fetch')));

async function build(options: ConfigShowCommandOptions = {}) {
  return (await buildConfigReport(options, { fetchImpl: noFetch })).data;
}

describe('config show: config file', () => {
  it('reports a missing file named by LLM_USAGE_CONFIG_PATH', async () => {
    const data = await build();

    expect(data.configFile).toEqual({
      path: path.join(caseDir, 'config.toml'),
      origin: 'env',
      exists: false,
    });
  });

  it('keeps unknown-key warnings out of the JSON on stdout', async () => {
    await writeConfig('timezone = "UTC"\nnotAKey = 1\n');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const stdout = await captureJsonStdout(() => runConfigShow({ json: true }));

    expect(JSON.parse(stdout)).toMatchObject({
      report: 'config-show',
      data: { configFile: { exists: true } },
    });
    expect(stdout).not.toContain('notAKey');
    stderr.mockRestore();
  });
});

describe('config show: sources', () => {
  it('names the layer each source path comes from and whether it exists', async () => {
    const claudeDir = path.join(caseDir, 'claude-projects');
    const codexDir = path.join(caseDir, 'codex-sessions');
    await mkdir(claudeDir);
    await mkdir(codexDir);
    vi.stubEnv('GEMINI_CLI_HOME', path.join(caseDir, 'gemini-home'));
    await writeConfig(
      `[sourceDirs]\nclaude = ${JSON.stringify(claudeDir)}\npi = ${JSON.stringify(path.join(caseDir, 'pi'))}\n`,
    );

    const data = await build({
      codexDir,
      sourceDir: [`pi=${claudeDir}`],
    });
    const byId = new Map(data.sources.map((source) => [source.id, source]));

    expect(byId.get('codex')).toMatchObject({
      origin: 'cli',
      paths: [{ path: codexDir, exists: true }],
    });
    // A --source-dir beats the config's sourceDirs for the same source.
    expect(byId.get('pi')).toMatchObject({
      origin: 'cli',
      paths: [{ path: claudeDir, exists: true }],
    });
    expect(byId.get('claude')).toMatchObject({
      origin: 'config',
      paths: [{ path: claudeDir, exists: true }],
    });
    expect(byId.get('gemini')).toMatchObject({
      origin: 'env',
      paths: [{ path: path.join(caseDir, 'gemini-home'), exists: false }],
    });
    expect(byId.get('droid')?.origin).toBe('default');
    expect(byId.get('droid')?.paths.every((entry) => !entry.exists)).toBe(true);
  });

  it('lists only the sources the filter selects', async () => {
    const data = await build({ source: ['codex'] });

    expect(data.sources.map((source) => source.id)).toEqual(['codex']);
    expect(data.defaults.sources).toEqual({ value: ['codex'], origin: 'cli' });
  });
});

describe('config show: event store', () => {
  it('says the store and history are off when an env var disables it, without reading it', async () => {
    const readSummary = vi.fn(readEventStoreSummary);
    const { data } = await buildConfigReport({}, { readEventStoreSummary: readSummary });

    expect(data.eventStore.enabled).toEqual({ value: false, origin: 'env' });
    expect(data.eventStore.file).toBeUndefined();
    expect(data.defaults.history).toBe(false);
    expect(readSummary).not.toHaveBeenCalled();
  });

  it('reads size, schema and event count without writing to the store', async () => {
    const storePath = path.join(caseDir, 'store', 'events.db');
    await mkdir(path.dirname(storePath));
    closeEventStore(await openEventStore(storePath));
    vi.stubEnv('LLM_USAGE_EVENT_STORE', undefined);
    await writeConfig(`[eventStore]\npath = ${JSON.stringify(storePath)}\n`);
    const before = await stat(storePath);
    const bytesBefore = await readFile(storePath);

    const data = await build();

    expect(data.eventStore.path).toEqual({ value: storePath, origin: 'config' });
    expect(data.eventStore.enabled).toEqual({ value: true, origin: 'default' });
    expect(data.eventStore.file).toEqual({
      state: 'ok',
      sizeBytes: before.size,
      schemaVersion: expect.any(String) as string,
      eventCount: 0,
    });
    expect(data.defaults.history).toBe(true);
    // SQLite may add -wal/-shm sidecars on a read-only open; the database itself is untouched.
    expect((await stat(storePath)).mtimeMs).toBe(before.mtimeMs);
    expect((await readFile(storePath)).equals(bytesBefore)).toBe(true);
  });

  it('reports a store that was never created', async () => {
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(caseDir, 'none', 'events.db'));

    const data = await build();

    expect(data.eventStore.path.origin).toBe('env');
    expect(data.eventStore.file).toEqual({ state: 'missing' });
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', undefined);
  });
});

describe('config show: machines', () => {
  it('lists configured machines by name without running ssh', async () => {
    await writeConfig(
      '[machines.laptop]\nssh = "me@laptop.local"\n\n[machines.old]\nssh = "me@old.local"\nenabled = false\n',
    );

    const data = await build();

    expect(data.machines).toEqual([
      { name: 'laptop', enabled: true },
      { name: 'old', enabled: false },
    ]);
    expect(JSON.stringify(data)).not.toContain('me@laptop.local');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
  });
});

describe('config show: pricing', () => {
  it('says the next report fetches when there is no cache, and fetches nothing itself', async () => {
    const data = await build();

    expect(data.pricing).toMatchObject({
      url: { value: DEFAULT_LITELLM_PRICING_URL, origin: 'default' },
      offline: { value: false, origin: 'default' },
      cache: { state: 'none' },
      pricesFrom: 'network',
    });
    expect(data.pricing.overrides).toBeUndefined();
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('uses a fresh cache and gives its fetch time', async () => {
    const fetchedAt = Date.now() - HOUR_MS;
    await writePricingCache(fetchedAt);

    const data = await build();

    expect(data.pricing).toMatchObject({
      cache: { state: 'fresh', fetchedAt: new Date(fetchedAt).toISOString() },
      pricesFrom: 'cache',
      pricesFetchedAt: new Date(fetchedAt).toISOString(),
    });
  });

  it('refetches past the refresh interval online and keeps the stale cache offline', async () => {
    await writePricingCache(Date.now() - 2 * HOUR_MS);
    await writeConfig('[pricing]\ncacheTtlMs = 3600000\n');

    const online = await build();
    const offline = await build({ pricingOffline: true });

    expect(online.pricing).toMatchObject({
      cacheTtlMs: { value: HOUR_MS, origin: 'config' },
      cache: { state: 'stale' },
      pricesFrom: 'network',
    });
    expect(offline.pricing).toMatchObject({
      offline: { value: true, origin: 'cli' },
      cache: { state: 'stale' },
      pricesFrom: 'cache',
    });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('falls back to the bundled snapshot offline, and to nothing for a custom URL', async () => {
    const snapshot = await build({ pricingOffline: true });
    const custom = await build({
      pricingOffline: true,
      pricingUrl: 'https://example.test/prices.json',
    });

    expect(snapshot.pricing.pricesFrom).toBe('bundled-snapshot');
    expect(snapshot.pricing.pricesFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(custom.pricing).toMatchObject({
      url: { value: 'https://example.test/prices.json', origin: 'cli' },
      cache: { state: 'none' },
      pricesFrom: 'none',
    });
  });

  it('ignores a cache fetched from another URL', async () => {
    await writePricingCache(Date.now(), 'https://example.test/other.json');

    const data = await build();

    expect(data.pricing.cache.state).toBe('none');
  });

  it('reports the overrides file and whether it exists', async () => {
    const overridesPath = path.join(caseDir, 'overrides.json');
    await writeConfig(`[pricing]\noverridesPath = ${JSON.stringify(overridesPath)}\n`);

    const missing = await build();
    await writeFile(overridesPath, '{}');
    const present = await build();

    expect(missing.pricing.overrides).toEqual({
      path: { value: overridesPath, origin: 'config' },
      exists: false,
    });
    expect(present.pricing.overrides?.exists).toBe(true);
  });
});

describe('config show: defaults', () => {
  it('resolves timezone and parser settings with their origins', async () => {
    await writeConfig('timezone = "Asia/Tokyo"\nparseMaxParallel = 3\nparseWorkers = 2\n');
    vi.stubEnv('LLM_USAGE_PARSE_WORKERS', '5');

    const fromConfig = await build();
    const fromFlag = await build({ timezone: 'Europe/Paris' });

    expect(fromConfig.defaults).toMatchObject({
      timezone: { value: 'Asia/Tokyo', origin: 'config' },
      sources: { value: [], origin: 'default' },
      parseWorkers: { value: 5, origin: 'env' },
      parseMaxParallel: { value: 3, origin: 'config' },
      parseWorkerMinBytes: { origin: 'default' },
    });
    expect(fromFlag.defaults.timezone).toEqual({ value: 'Europe/Paris', origin: 'cli' });
  });

  it('shows the auto worker count a run uses, lower with the event store on', async () => {
    const autoWorkers = (limit: number) => Math.max(0, Math.min(limit, availableParallelism() - 1));

    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    const storeOn = await build();
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
    const storeOff = await build();

    expect(storeOn.defaults.parseWorkers).toEqual({ value: autoWorkers(6), origin: 'default' });
    expect(storeOff.defaults.parseWorkers).toEqual({ value: autoWorkers(8), origin: 'default' });
  });

  it('rejects an invalid timezone before reading anything', async () => {
    await expect(build({ timezone: 'Mars/Olympus' })).rejects.toThrow('Invalid timezone');
  });
});

describe('config show: json', () => {
  it('matches the report-config schema', async () => {
    await writePricingCache(Date.now());
    await writeConfig('[machines.laptop]\nssh = "me@laptop.local"\n');

    const stdout = await captureJsonStdout(() =>
      runConfigShow({ json: true, pricingOverrides: path.join(caseDir, 'missing.json') }),
    );

    validateReportOutput(compileReportValidators(), 'config-show', stdout);
  });
});
