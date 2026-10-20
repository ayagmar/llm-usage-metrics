import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionData } from '../../src/cli/build-session-data.js';
import { buildToolsData } from '../../src/cli/build-tools-data.js';
import { schemaDocuments } from '../../src/cli/report-schema-registry.js';
import type { BuildUsageDataDeps } from '../../src/cli/usage-data-contracts.js';
import { loadUserConfig } from '../../src/config/user-config.js';
import {
  deleteMachineCache,
  getMachineCachePath,
  openMachineCache,
} from '../../src/machines/machine-cache.js';
import { syncMachine } from '../../src/machines/sync-machine.js';
import {
  closeEventStore,
  listStoredFileFingerprints,
  readFileEvents,
} from '../../src/persistence/event-store.js';
import { writeV4Store } from '../helpers/event-store-v4.js';
import { createInProcessRemote } from '../helpers/machine-remote.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';

// Real claude, codex and pi logs with tool calls and turns.
const FIXTURES = path.resolve('tests/fixtures/tools');
const NOW = new Date('2026-07-10T12:00:00.000Z');

type Side = { configPath: string; eventStorePath: string };

async function writeSide(rootDir: string, options: { machines: boolean }): Promise<Side> {
  await cp(FIXTURES, path.join(rootDir, 'logs'), { recursive: true });
  const configPath = path.join(rootDir, 'config.toml');
  await writeFile(
    configPath,
    [
      'sources = ["claude", "codex", "pi"]',
      '[sourceDirs]',
      ...['claude', 'codex', 'pi'].map(
        (source) => `${source} = ${JSON.stringify(path.join(rootDir, 'logs', source))}`,
      ),
      ...(options.machines ? ['[machines.laptop]', 'ssh = "me@laptop"'] : []),
      '',
    ].join('\n'),
  );
  return { configPath, eventStorePath: path.join(rootDir, 'events.db') };
}

function depsFor(side: Side): BuildUsageDataDeps {
  return {
    now: () => NOW,
    loadUserConfig: () => loadUserConfig({ LLM_USAGE_CONFIG_PATH: side.configPath }),
    getEventStoreRuntimeConfig: () => ({ enabled: true, path: side.eventStorePath }),
  };
}

describe('tool calls and turns of other machines', () => {
  const environment = useIsolatedEnvironment();
  let local: Side;
  let remote: Side;
  let runId = 0;

  beforeEach(async () => {
    // A fresh pair of machines per test; XDG_DATA_HOME holds the machine cache.
    runId += 1;
    const rootDir = path.join(environment.rootDir, `run-${String(runId)}`);
    await mkdir(path.join(rootDir, 'local'), { recursive: true });
    await mkdir(path.join(rootDir, 'remote'), { recursive: true });
    local = await writeSide(path.join(rootDir, 'local'), { machines: true });
    remote = await writeSide(path.join(rootDir, 'remote'), { machines: false });
    vi.stubEnv('XDG_DATA_HOME', path.join(rootDir, 'data'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  async function sync(rewrite?: (bundle: string) => string): Promise<void> {
    const { spawnSsh } = createInProcessRemote({ ...remote, rewrite });
    const outcome = await syncMachine('laptop', { ssh: 'me@laptop' }, { spawnSsh, full: true });
    expect(outcome.ok).toBe(true);
  }

  function tools(side: Side, machine?: string[]) {
    return buildToolsData(
      { timezone: 'UTC', all: true, sync: false, ...(machine ? { machine } : {}) },
      depsFor(side),
    );
  }

  async function timeline(side: Side, machine?: string[]) {
    const result = await buildSessionData(
      {
        timezone: 'UTC',
        sync: false,
        id: ['evt-session'],
        timeline: true,
        pricingOffline: true,
        ...(machine ? { machine } : {}),
      },
      depsFor(side),
    );
    if (result.grouping !== 'timeline') {
      throw new Error('expected a timeline');
    }
    return result.rows;
  }

  it('shows the laptop tool calls with --machine, as tools on the laptop counts them', async () => {
    const validate = new Ajv2020({ allErrors: true }).compile(
      schemaDocuments['machine-export'] as object,
    );
    let printed = '';
    await sync((bundle) => (printed = bundle));

    const lines = printed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.filter((line) => line.sessionEvents !== undefined)).toHaveLength(3);
    for (const line of lines) {
      expect(validate(line), JSON.stringify(validate.errors)).toBe(true);
    }

    const there = await tools(remote);
    const here = await tools(local, ['laptop']);

    expect(there.data.totals.calls).toBeGreaterThan(0);
    expect(here.data).toEqual(there.data);
  });

  it('shows the laptop timeline with --machine, turns included', async () => {
    await sync();

    const rows = await timeline(local, ['laptop']);

    expect(rows).toEqual(await timeline(remote));
    expect(rows.map((row) => row.kind)).toEqual(expect.arrayContaining(['message', 'tool_call']));
  });

  it('counts a session both machines hold once', async () => {
    await sync();

    expect((await tools(local)).data).toEqual((await tools(local, ['local'])).data);
    // Turns carry no id that dedupeToolCalls could match; only the machine merge drops them.
    expect(await timeline(local)).toEqual(await timeline(local, ['local']));
  });

  it('matches turns on timestamp when the laptop parses with another parser version', async () => {
    // The laptop's copy of a claude turn differs, as another parser could make it.
    const differing = (bundle: string) =>
      bundle.replace(
        /("kind":"message","source":"claude","sessionId":"evt-session"[^}]*"textLength":)\d+/u,
        '$19000',
      );
    const reparsed = (bundle: string) =>
      differing(bundle).replace(/"claude":"[^"]+"/u, '"claude":"n0.p0"');

    await sync(reparsed);
    const underSkew = await timeline(local);
    await sync(differing);
    const sameVersion = await timeline(local);
    const localOnly = await timeline(local, ['local']);

    expect(underSkew).toEqual(localOnly);
    // Without the skew, the changed copy is another turn.
    expect(sameVersion).toHaveLength(localOnly.length + 1);
  });

  it('merges an export without tool calls (an older version) as usage only', async () => {
    const withoutSessionEvents = (bundle: string) =>
      bundle.replaceAll(/,"sessionEvents":\[[^\]]*\]/gu, '');

    await sync(withoutSessionEvents);
    const laptop = await tools(local, ['laptop']);

    expect(laptop.data.totals.calls).toBe(0);
    expect(laptop.diagnostics.warnings).toEqual([]);
    expect((await timeline(local, ['laptop'])).map((row) => row.kind)).toEqual(
      (await timeline(remote)).filter((row) => row.kind === 'usage').map((row) => row.kind),
    );
  });

  it('gets the tool calls a 0.11.0 reader dropped once the reader upgrades', async () => {
    // The laptop already exports tool calls; 0.11.0 here stored its revisions without them.
    await sync((bundle) => bundle.replaceAll(/,"sessionEvents":\[[^\]]*\]/gu, ''));
    const cache = await openMachineCache('laptop');
    cache.database.prepare("DELETE FROM meta WHERE key = 'sessionEventsKept'").run();
    closeEventStore(cache);

    const { spawnSsh } = createInProcessRemote(remote);
    const outcome = await syncMachine('laptop', { ssh: 'me@laptop' }, { spawnSsh });

    expect(outcome).toMatchObject({ ok: true, result: { receivedFileCount: 3 } });
    expect((await tools(local, ['laptop'])).data).toEqual((await tools(remote)).data);
  });

  it('gets the request ids a reader without them dropped once the reader upgrades', async () => {
    // The laptop already exports ids; a reader that predates them stored its revisions
    // without them, and marked the cache as keeping only tool calls and messages.
    await sync((bundle) => bundle.replaceAll(/,"(?:messageId|requestId)":"[^"]*"/gu, ''));
    const stale = await openMachineCache('laptop');
    stale.database.prepare("UPDATE meta SET value = '1' WHERE key = 'sessionEventsKept'").run();
    closeEventStore(stale);

    const { spawnSsh } = createInProcessRemote(remote);
    const outcome = await syncMachine('laptop', { ssh: 'me@laptop' }, { spawnSsh });

    expect(outcome).toMatchObject({ ok: true, result: { receivedFileCount: 3 } });
    const cache = await openMachineCache('laptop');

    try {
      const claudeEvents = listStoredFileFingerprints(cache)
        .filter((file) => file.source === 'claude')
        .flatMap((file) => readFileEvents(cache, file.source, file.filePath) ?? []);

      expect(claudeEvents.length).toBeGreaterThan(0);
      expect(claudeEvents.every((event) => event.messageId !== undefined)).toBe(true);
    } finally {
      closeEventStore(cache);
    }
  });

  it('reads no tool calls from a cache last synced before the store kept them', async () => {
    await sync();
    // As a sync by 0.11.0 left it: schema v4, without the tables; reports never migrate it.
    const cache = await openMachineCache('laptop');
    const files = listStoredFileFingerprints(cache).map((file) => ({
      ...file,
      events: readFileEvents(cache, file.source, file.filePath) ?? [],
    }));
    const meta = new Map(
      cache.database
        .prepare("SELECT key, value FROM meta WHERE key <> 'schemaVersion'")
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    );
    closeEventStore(cache);
    await deleteMachineCache('laptop');
    await writeV4Store(getMachineCachePath('laptop'), files, meta);

    const laptop = await tools(local, ['laptop']);

    expect(laptop.data.totals.calls).toBe(0);
    expect(laptop.diagnostics.warnings).toEqual([]);
  });
});
