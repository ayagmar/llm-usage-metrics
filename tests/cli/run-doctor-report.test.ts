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
} from '../../src/persistence/event-store.js';

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

function eventStoreDisabledDeps(): {
  getEventStoreRuntimeConfig: () => { enabled: false; path: string };
} {
  return {
    getEventStoreRuntimeConfig: () => ({
      enabled: false,
      path: '/tmp/events.db',
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
      { id: 'pi', status: 'ok', itemsFound: 1 },
      { id: 'codex', status: 'ok', itemsFound: 1 },
      { id: 'gemini', status: 'ok', itemsFound: 1 },
      { id: 'droid', status: 'ok', itemsFound: 1 },
      { id: 'opencode', status: 'ok', itemsFound: 1 },
      { id: 'openclaw', status: 'ok', itemsFound: 1 },
      { id: 'claude', status: 'ok', itemsFound: 1 },
      { id: 'copilot', status: 'ok', itemsFound: 1 },
      { id: 'goose', status: 'ok', itemsFound: 1 },
      { id: 'amp', status: 'ok', itemsFound: 1 },
      { id: 'qwen', status: 'ok', itemsFound: 1 },
      { id: 'kimi', status: 'ok', itemsFound: 1 },
      { id: 'cline', status: 'ok', itemsFound: 1 },
      { id: 'roocode', status: 'ok', itemsFound: 1 },
      { id: 'kilocode', status: 'ok', itemsFound: 1 },
      { id: 'antigravity', status: 'ok', itemsFound: 1 },
    ]);
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
        }),
      },
    );

    expect(results).toEqual([{ id: 'pi', status: 'ok', itemsFound: 1 }]);
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
      { id: 'pi', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
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

    const readEventStoreSummarySpy = vi.fn(async () => ({ eventCount: 42, schemaVersion: '1' }));

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
      },
    );

    expect(readEventStoreSummarySpy).toHaveBeenCalledWith(eventStorePath);
    expect(results).toEqual([
      { id: 'pi', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
        status: 'ok',
        itemsFound: 42,
        detail: '42 event(s)',
      },
    ]);
  });

  it('reports a stale event store schema as healthy without mutating it', async () => {
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
      { id: 'pi', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
        status: 'ok',
        itemsFound: 0,
        detail: 'schema v999 (will be rebuilt on next run)',
      },
    ]);
    // The doctor check must be read-only: the stale version survives it.
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
      { id: 'pi', status: 'ok', itemsFound: 1 },
      {
        id: 'event-store',
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

    expect(stdout.getOutput()).toContain('gemini  ok');
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

    expect(stdout.getOutput()).toContain('claude');
    expect(stdout.getOutput()).toContain('error');
    expect(stdout.getOutput()).toContain(missingClaudeDir);
    expect(stdout.getOutput()).toContain('15/16 sources healthy');
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
      sources: [{ id: 'gemini', status: 'ok', itemsFound: 1 }],
    });
  });
});
