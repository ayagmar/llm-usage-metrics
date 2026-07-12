import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDoctorResults,
  runDoctorReport,
  type DoctorSourceResult,
} from '../../src/cli/run-doctor-report.js';
import type { DoctorCommandOptions } from '../../src/cli/usage-data-contracts.js';
import {
  closeEventStore,
  openEventStore,
  readEventStoreSummary,
  replaceFileEvents,
  type EventStore,
  type EventStoreFileFingerprint,
} from '../../src/persistence/event-store.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

const tempDirs: string[] = [];

beforeEach(() => {
  // Keep the vitest-wide store-off default: deleting LLM_USAGE_EVENT_STORE
  // would re-enable the default-on store against the user's real events.db.
  process.env.LLM_USAGE_EVENT_STORE = '0';
  delete process.env.LLM_USAGE_EVENT_STORE_PATH;
});

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
  process.env.LLM_USAGE_EVENT_STORE = '0';
  delete process.env.LLM_USAGE_EVENT_STORE_PATH;
  vi.restoreAllMocks();
});

async function createDoctorFixtureOptions(): Promise<DoctorCommandOptions> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-fixtures-'));
  tempDirs.push(rootDir);

  const piDir = path.join(rootDir, 'pi');
  const codexDir = path.join(rootDir, 'codex');
  const copilotDir = path.join(rootDir, 'copilot');
  const geminiDir = path.join(rootDir, 'gemini');
  const droidDir = path.join(rootDir, 'droid');
  const claudeDir = path.join(rootDir, 'claude');
  const openclawDir = path.join(rootDir, 'openclaw');
  const opencodeDb = path.join(rootDir, 'opencode.db');
  const gooseDb = path.join(rootDir, 'goose.db');
  const ampDir = path.join(rootDir, 'amp');
  const qwenDir = path.join(rootDir, 'qwen');
  const kimiDir = path.join(rootDir, 'kimi');
  const clineDir = path.join(rootDir, 'cline');
  const roocodeDir = path.join(rootDir, 'roocode');
  const kilocodeDir = path.join(rootDir, 'kilocode');
  const antigravityDir = path.join(rootDir, 'antigravity');

  await mkdir(path.join(geminiDir, 'tmp', 'project', 'chats'), { recursive: true });
  await mkdir(path.join(qwenDir, 'project', 'chats'), { recursive: true });
  await mkdir(path.join(kimiDir, 'group-a', 'session-a'), { recursive: true });
  await mkdir(path.join(clineDir, 'task-a'), { recursive: true });
  await mkdir(path.join(roocodeDir, 'task-a'), { recursive: true });
  await mkdir(path.join(kilocodeDir, 'task-a'), { recursive: true });
  await mkdir(antigravityDir, { recursive: true });
  await mkdir(path.join(claudeDir, 'project'), { recursive: true });
  await mkdir(piDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await mkdir(copilotDir, { recursive: true });
  await mkdir(droidDir, { recursive: true });
  await mkdir(openclawDir, { recursive: true });
  await mkdir(ampDir, { recursive: true });

  await writeFile(path.join(piDir, 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(codexDir, 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(copilotDir, 'otel.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(geminiDir, 'tmp', 'project', 'chats', 'session.json'), '{}', 'utf8');
  await writeFile(path.join(droidDir, 'session.settings.json'), '{}', 'utf8');
  await writeFile(path.join(claudeDir, 'project', 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(openclawDir, 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(opencodeDb, '', 'utf8');
  await writeFile(gooseDb, '', 'utf8');
  await writeFile(path.join(ampDir, 'thread.json'), '{}', 'utf8');
  await writeFile(path.join(qwenDir, 'project', 'chats', 'session.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(kimiDir, 'group-a', 'session-a', 'wire.jsonl'), '{}\n', 'utf8');
  await writeFile(path.join(clineDir, 'task-a', 'ui_messages.json'), '[]', 'utf8');
  await writeFile(path.join(roocodeDir, 'task-a', 'ui_messages.json'), '[]', 'utf8');
  await writeFile(path.join(kilocodeDir, 'task-a', 'ui_messages.json'), '[]', 'utf8');
  await writeFile(path.join(antigravityDir, 'conversation.db'), '', 'utf8');

  return {
    piDir,
    codexDir,
    copilotDir,
    geminiDir,
    droidDir,
    claudeDir,
    openclawDir,
    opencodeDb,
    gooseDb,
    ampDir,
    qwenDir,
    kimiDir,
    clineDir,
    roocodeDir,
    kilocodeDir,
    antigravityDir,
  };
}

function sourceById(results: DoctorSourceResult[]): Map<string, DoctorSourceResult> {
  return new Map(results.map((result) => [result.id, result]));
}

function createEvent(overrides: Partial<Parameters<typeof createUsageEvent>[0]> = {}) {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-02-14T10:00:00.000Z',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    costMode: 'estimated',
    ...overrides,
  });
}

function createFingerprint(filePath: string): EventStoreFileFingerprint {
  return {
    dependencies: [{ path: filePath, exists: true, size: 10, mtimeMs: 20 }],
  };
}

function writeStoredFile(
  store: EventStore,
  options: {
    source?: string;
    filePath: string;
  },
): void {
  replaceFileEvents(store, {
    source: options.source ?? 'pi',
    filePath: options.filePath,
    fingerprint: createFingerprint(options.filePath),
    events: [createEvent({ source: options.source ?? 'pi' })],
    skippedRows: 0,
    now: 1_000,
  });
}

function eventStoreDisabledDeps(): {
  getEventStoreRuntimeConfig: () => { enabled: false; path: string; disabledBy: 'environment' };
} {
  return {
    getEventStoreRuntimeConfig: () => ({
      enabled: false,
      path: '/tmp/events.db',
      disabledBy: 'environment',
    }),
  };
}

function captureStdout(): {
  getOutput: () => string;
  restore: () => void;
} {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });

  return {
    getOutput: () => chunks.join(''),
    restore: () => {
      writeSpy.mockRestore();
    },
  };
}

describe('run-doctor-report', () => {
  it('discovers all sources in registration order', async () => {
    const options = await createDoctorFixtureOptions();

    const results = await buildDoctorResults(options, eventStoreDisabledDeps());

    expect(results).toEqual([
      { id: 'pi', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'codex', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'gemini', format: 'json', status: 'ok', itemsFound: 1 },
      { id: 'droid', format: 'json', status: 'ok', itemsFound: 1 },
      { id: 'opencode', format: 'sqlite', status: 'ok', itemsFound: 1 },
      { id: 'openclaw', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'claude', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'copilot', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'goose', format: 'sqlite', status: 'ok', itemsFound: 1 },
      { id: 'amp', format: 'json', status: 'ok', itemsFound: 1 },
      { id: 'qwen', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'kimi', format: 'jsonl', status: 'ok', itemsFound: 1 },
      { id: 'cline', format: 'json', status: 'ok', itemsFound: 1 },
      { id: 'roocode', format: 'json', status: 'ok', itemsFound: 1 },
      { id: 'kilocode', format: 'json', status: 'ok', itemsFound: 1 },
      { id: 'antigravity', format: 'sqlite', status: 'ok', itemsFound: 1 },
    ]);
  });

  it('probes the config sourceDirs override when no dir flag is set', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-config-dir-'));
    tempDirs.push(rootDir);

    const missingPiDir = path.join(rootDir, 'configured-pi');
    const configPath = path.join(rootDir, 'config.toml');
    await writeFile(configPath, `[sourceDirs]\npi = "${missingPiDir}"\n`, 'utf8');

    const previousConfigPath = process.env.LLM_USAGE_CONFIG_PATH;
    process.env.LLM_USAGE_CONFIG_PATH = configPath;

    try {
      const results = await buildDoctorResults({ source: 'pi' }, eventStoreDisabledDeps());

      expect(results[0]).toMatchObject({ id: 'pi', status: 'error' });
      expect(results[0]?.error).toContain(missingPiDir);
    } finally {
      process.env.LLM_USAGE_CONFIG_PATH = previousConfigPath;
    }
  });

  it('reads the event store from the config eventStore.path', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-config-store-'));
    tempDirs.push(rootDir);

    const eventStorePath = path.join(rootDir, 'configured-events.db');
    const store = await openEventStore(eventStorePath);

    try {
      writeStoredFile(store, { filePath: '/tmp/departed-pi.jsonl' });
    } finally {
      closeEventStore(store);
    }

    const configPath = path.join(rootDir, 'config.toml');
    await writeFile(
      configPath,
      `[eventStore]\nenabled = true\npath = "${eventStorePath}"\n`,
      'utf8',
    );

    const previousConfigPath = process.env.LLM_USAGE_CONFIG_PATH;
    process.env.LLM_USAGE_CONFIG_PATH = configPath;
    delete process.env.LLM_USAGE_EVENT_STORE;

    try {
      const results = await buildDoctorResults({ source: 'pi' });
      const eventStoreResult = results.find((result) => result.id === 'event-store');

      expect(eventStoreResult).toMatchObject({ id: 'event-store', status: 'ok', itemsFound: 1 });
    } finally {
      process.env.LLM_USAGE_CONFIG_PATH = previousConfigPath;
      process.env.LLM_USAGE_EVENT_STORE = '0';
    }
  });

  it('emits the Active config block and unknown-key warnings on doctor', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-config-emit-'));
    tempDirs.push(rootDir);

    const configPath = path.join(rootDir, 'config.toml');
    await writeFile(configPath, `mystery = true\n\n[sourceDirs]\npi = "${rootDir}"\n`, 'utf8');

    const previousConfigPath = process.env.LLM_USAGE_CONFIG_PATH;
    process.env.LLM_USAGE_CONFIG_PATH = configPath;
    const stderrChunks: string[] = [];
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((message) => stderrChunks.push(String(message)));
    const stdout = captureStdout();

    try {
      await runDoctorReport({ source: 'pi' }, eventStoreDisabledDeps());
    } finally {
      stdout.restore();
      errorSpy.mockRestore();
      process.env.LLM_USAGE_CONFIG_PATH = previousConfigPath;
    }

    const stderr = stderrChunks.join('\n');
    expect(stderr).toContain('Active config:');
    expect(stderr).toContain(`sourceDirs.pi=${rootDir}`);
    expect(stderr).toContain('Unknown config key(s): mystery');
  });

  it('reports one source error without stopping other source checks', async () => {
    const options = await createDoctorFixtureOptions();
    const missingClaudeDir = path.join(os.tmpdir(), `missing-claude-${Date.now()}`);

    const results = await buildDoctorResults(
      {
        ...options,
        claudeDir: missingClaudeDir,
      },
      eventStoreDisabledDeps(),
    );
    const resultsBySource = sourceById(results);
    const claudeResult = resultsBySource.get('claude');
    const nonClaudeResults = results.filter((result) => result.id !== 'claude');

    expect(claudeResult?.id).toBe('claude');
    expect(claudeResult?.status).toBe('error');
    expect(claudeResult?.error).toContain(missingClaudeDir);
    expect(nonClaudeResults.every((result) => result.status === 'ok')).toBe(true);
  });

  it('filters doctor results with comma-separated source filters', async () => {
    const options = await createDoctorFixtureOptions();

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'gemini,claude',
      },
      eventStoreDisabledDeps(),
    );

    expect(results.map((result) => result.id)).toEqual(['gemini', 'claude']);
  });

  it('rejects unknown source filters with the shared error wording', async () => {
    await expect(buildDoctorResults({ source: 'unknown' })).rejects.toThrow(
      'Unknown --source value(s): unknown. Allowed values:',
    );
  });

  it('omits the event store doctor row when the runtime flag is disabled', async () => {
    const options = await createDoctorFixtureOptions();

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'pi',
      },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: false,
          path: '/tmp/events.db',
          disabledBy: 'environment',
        }),
      },
    );

    expect(results).toEqual([{ id: 'pi', format: 'jsonl', status: 'ok', itemsFound: 1 }]);
  });

  it('reports an enabled event store that has not been created yet as healthy', async () => {
    const options = await createDoctorFixtureOptions();
    const eventStorePath = path.join(os.tmpdir(), `missing-events-${Date.now()}.db`);

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'pi',
      },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: true,
          path: eventStorePath,
        }),
      },
    );

    expect(results).toEqual([
      { id: 'pi', format: 'jsonl', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
        format: 'sqlite',
        status: 'ok',
        itemsFound: 0,
        detail: 'not yet created',
      },
    ]);
  });

  it('counts events for an existing enabled event store', async () => {
    const options = await createDoctorFixtureOptions();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-event-store-'));
    tempDirs.push(rootDir);

    const eventStorePath = path.join(rootDir, 'events.db');
    await writeFile(eventStorePath, '', 'utf8');

    const readEventStoreSummarySpy = vi.fn(async () => ({ eventCount: 42, schemaVersion: '3' }));
    const readEventStoreStoredFilesSpy = vi.fn(async () => []);

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'pi',
      },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: true,
          path: eventStorePath,
        }),
        readEventStoreSummary: readEventStoreSummarySpy,
        readEventStoreStoredFiles: readEventStoreStoredFilesSpy,
      },
    );

    expect(readEventStoreSummarySpy).toHaveBeenCalledWith(eventStorePath);
    expect(readEventStoreStoredFilesSpy).toHaveBeenCalledWith(eventStorePath);
    expect(results).toEqual([
      { id: 'pi', format: 'jsonl', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
        format: 'sqlite',
        status: 'ok',
        itemsFound: 42,
        detail: '42 event(s), 0 departed file(s), schema v3, 0 B',
      },
    ]);
  });

  it('counts departed files for selected sources without mutating the store', async () => {
    const options = await createDoctorFixtureOptions();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-event-store-departed-'));
    tempDirs.push(rootDir);

    const eventStorePath = path.join(rootDir, 'events.db');
    const livePiFilePath = path.join(options.piDir ?? '', 'session.jsonl');
    const store = await openEventStore(eventStorePath);

    try {
      writeStoredFile(store, { filePath: livePiFilePath });
      writeStoredFile(store, { filePath: '/tmp/departed-pi.jsonl' });
      writeStoredFile(store, { source: 'codex', filePath: '/tmp/departed-codex.jsonl' });
    } finally {
      closeEventStore(store);
    }

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'pi',
      },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: true,
          path: eventStorePath,
        }),
      },
    );
    const eventStoreResult = results.find((result) => result.id === 'event-store');

    expect(eventStoreResult).toMatchObject({
      id: 'event-store',
      status: 'ok',
      itemsFound: 3,
    });
    expect(eventStoreResult?.detail).toMatch(/^3 event\(s\), 1 departed file\(s\), schema v3, .+$/);
    await expect(readEventStoreSummary(eventStorePath)).resolves.toMatchObject({
      eventCount: 3,
      schemaVersion: '3',
    });
  });

  it('reports a newer event store schema as an error without mutating it', async () => {
    const options = await createDoctorFixtureOptions();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-event-store-stale-'));
    tempDirs.push(rootDir);

    const eventStorePath = path.join(rootDir, 'events.db');
    const store = await openEventStore(eventStorePath);
    store.database.prepare("UPDATE meta SET value = '999' WHERE key = 'schemaVersion'").run();
    closeEventStore(store);

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'pi',
      },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: true,
          path: eventStorePath,
        }),
      },
    );

    expect(results).toEqual([
      { id: 'pi', format: 'jsonl', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
        format: 'sqlite',
        status: 'error',
        error:
          'Event store schema v999 is not supported by this llm-usage-metrics version (supports v3); upgrade llm-usage-metrics or set LLM_USAGE_EVENT_STORE=0',
      },
    ]);
    // The doctor check must be read-only: the newer version survives it.
    await expect(readEventStoreSummary(eventStorePath)).resolves.toEqual({
      eventCount: 0,
      schemaVersion: '999',
    });
  });

  it('reports an enabled event store open failure as an error', async () => {
    const options = await createDoctorFixtureOptions();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'doctor-event-store-error-'));
    tempDirs.push(rootDir);

    const eventStorePath = path.join(rootDir, 'events.db');
    await writeFile(eventStorePath, '', 'utf8');

    const results = await buildDoctorResults(
      {
        ...options,
        source: 'pi',
      },
      {
        getEventStoreRuntimeConfig: () => ({
          enabled: true,
          path: eventStorePath,
        }),
        readEventStoreSummary: async () => {
          throw new Error('sqlite unavailable');
        },
      },
    );

    expect(results).toEqual([
      { id: 'pi', format: 'jsonl', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
        format: 'sqlite',
        status: 'error',
        error: 'sqlite unavailable',
      },
    ]);
  });

  it('prints plain text output to stdout', async () => {
    const options = await createDoctorFixtureOptions();
    const stdout = captureStdout();

    try {
      await runDoctorReport(
        {
          ...options,
          source: 'gemini',
        },
        eventStoreDisabledDeps(),
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.getOutput()).toContain('✔ gemini  json');
    expect(stdout.getOutput()).toContain('1/1 sources healthy');
  });

  it('prints plain text error details to stdout', async () => {
    const options = await createDoctorFixtureOptions();
    const missingClaudeDir = path.join(os.tmpdir(), `missing-claude-${Date.now()}`);
    const stdout = captureStdout();

    try {
      await runDoctorReport(
        {
          ...options,
          claudeDir: missingClaudeDir,
        },
        eventStoreDisabledDeps(),
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.getOutput()).toContain('✖ claude       jsonl');
    expect(stdout.getOutput()).toContain(missingClaudeDir);
    expect(stdout.getOutput()).toContain('15/16 sources healthy');
  });

  it('counts only source rows in the summary while still listing the event store', async () => {
    const options = await createDoctorFixtureOptions();
    const eventStorePath = path.join(os.tmpdir(), `missing-events-summary-${Date.now()}.db`);
    const stdout = captureStdout();

    try {
      await runDoctorReport(options, {
        getEventStoreRuntimeConfig: () => ({ enabled: true, path: eventStorePath }),
      });
    } finally {
      stdout.restore();
    }

    const output = stdout.getOutput();
    expect(output).toContain('event-store');
    expect(output).toContain('16/16 sources healthy');
  });

  it('prints JSON output to stdout', async () => {
    const options = await createDoctorFixtureOptions();
    const stdout = captureStdout();

    try {
      await runDoctorReport(
        {
          ...options,
          source: 'gemini',
          json: true,
        },
        eventStoreDisabledDeps(),
      );
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.getOutput())).toEqual({
      sources: [{ id: 'gemini', format: 'json', status: 'ok', itemsFound: 1 }],
    });
  });
});
