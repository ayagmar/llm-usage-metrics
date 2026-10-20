import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';

import { loadNodeSqliteModule } from '@ayagmar/agent-sessions/internal';
import { describe, expect, it, vi } from 'vitest';

import { buildSessionReport } from '../../src/cli/run-session-report.js';
import { buildToolsReport } from '../../src/cli/run-tools-report.js';
import type { SessionCommandOptions } from '../../src/cli/usage-data-contracts.js';
import type { SessionRow } from '../../src/session/session-row.js';
import {
  closeEventStore,
  listStoredFileFingerprints,
  openEventStore,
  readFileEvents,
} from '../../src/persistence/event-store.js';
import { writeV4Store } from '../helpers/event-store-v4.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';

// Both fixture sets with claude, codex and pi logs: the tools fixtures (tool calls, results,
// errors, turns) and the e2e fixtures. Gemini is a source the store keeps usage only for.
const FIXTURE_SETS = {
  tools: 'tests/fixtures/tools',
  e2e: 'tests/fixtures/e2e',
} as const;

type StoreMode = 'off' | 'cold' | 'warm';

type DatabaseHandle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...parameters: unknown[]) => Record<string, unknown>[];
    run: (...parameters: unknown[]) => unknown;
  };
  close: () => void;
};

async function openDatabase(filePath: string): Promise<DatabaseHandle> {
  const sqlite = (await loadNodeSqliteModule('test')) as {
    DatabaseSync: new (filePath: string) => DatabaseHandle;
  };
  return new sqlite.DatabaseSync(filePath);
}

describe('tools and session --timeline from the event store', () => {
  const environment = useIsolatedEnvironment();

  function sourceOptions(root: string): SessionCommandOptions {
    const withGemini = existsSync(path.join(root, 'gemini'));

    return {
      claudeDir: path.join(root, 'claude'),
      codexDir: path.join(root, 'codex'),
      piDir: path.join(root, 'pi'),
      ...(withGemini && { geminiDir: path.join(root, 'gemini') }),
      source: withGemini ? 'claude,codex,pi,gemini' : 'claude,codex,pi',
      timezone: 'UTC',
      json: true,
    };
  }

  async function withStore<T>(storePath: string | undefined, run: () => Promise<T>): Promise<T> {
    vi.stubEnv('LLM_USAGE_EVENT_STORE', storePath === undefined ? '0' : '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', storePath);

    try {
      return await run();
    } finally {
      vi.stubEnv('LLM_USAGE_EVENT_STORE', '0');
      vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', undefined);
    }
  }

  /** Each session's `filePaths`, by `source:sessionId`, from session --json. */
  async function readSessionFilePaths(
    root: string,
    storePath?: string,
    extraOptions: SessionCommandOptions = {},
  ): Promise<Record<string, string[] | undefined>> {
    return withStore(storePath, async () => {
      const sessions = JSON.parse(
        await buildSessionReport({ ...sourceOptions(root), ...extraOptions }),
      ) as { data: SessionRow[] };

      return Object.fromEntries(
        sessions.data.map((row) => [`${row.source}:${row.sessionId}`, row.filePaths]),
      );
    });
  }

  /**
   * The session report JSON without the rows' `filePaths`, which only the event store gives
   * (see `readSessionFilePaths`). The report prints `JSON.stringify(…, null, 2)`, so every
   * other byte stays as printed.
   */
  function withoutFilePaths(text: string): string {
    const report = JSON.parse(text) as { data: SessionRow[] | { session: SessionRow } };
    const rows = Array.isArray(report.data) ? report.data : [report.data.session];

    for (const row of rows) {
      delete row.filePaths;
    }

    return JSON.stringify(report, null, 2);
  }

  /** The tools report, the session list and every session's timeline, as JSON text. */
  async function runReports(
    root: string,
    storePath?: string,
    extraOptions: SessionCommandOptions = {},
  ): Promise<Record<string, string>> {
    return withStore(storePath, async () => {
      const options = { ...sourceOptions(root), ...extraOptions };
      const sessionsText = await buildSessionReport(options);
      const sessions = JSON.parse(sessionsText) as {
        data: { sessionId: string; source: string }[];
      };
      const outputs: Record<string, string> = {
        tools: await buildToolsReport({ ...options, all: true, bySource: true }),
        sessions: withoutFilePaths(sessionsText),
      };

      for (const { source, sessionId } of sessions.data) {
        outputs[`${source}:${sessionId}`] = withoutFilePaths(
          await buildSessionReport({
            ...options,
            id: [sessionId],
            timeline: true,
          }),
        );
      }

      return outputs;
    });
  }

  for (const [name, fixtureDir] of Object.entries(FIXTURE_SETS)) {
    it(`reports the ${name} fixtures byte for byte the same with the store off, cold and warm`, async () => {
      const storePath = path.join(environment.rootDir, `${name}-parity.db`);
      const outputs = new Map<StoreMode, Record<string, string>>();

      outputs.set('off', await runReports(path.resolve(fixtureDir)));
      outputs.set('cold', await runReports(path.resolve(fixtureDir), storePath));
      outputs.set('warm', await runReports(path.resolve(fixtureDir), storePath));

      expect(Object.keys(outputs.get('off') ?? {}).length).toBeGreaterThan(3);
      expect(outputs.get('cold')).toEqual(outputs.get('off'));
      expect(outputs.get('warm')).toEqual(outputs.get('off'));

      // Only the store lists the files; each session's are under the fixture root.
      const root = path.resolve(fixtureDir);
      const storeOff = await readSessionFilePaths(root);
      const storeOn = await readSessionFilePaths(root, storePath);

      expect(Object.values(storeOff).every((paths) => paths === undefined)).toBe(true);
      expect(Object.keys(storeOn)).toEqual(Object.keys(storeOff));

      for (const paths of Object.values(storeOn)) {
        expect(paths?.length).toBeGreaterThan(0);
        expect(paths?.every((filePath) => filePath.startsWith(root + path.sep))).toBe(true);
      }
    });
  }

  it('reads the tool calls of files on disk from the store, not the files', async () => {
    const storePath = path.join(environment.rootDir, 'served.db');
    const root = path.resolve(FIXTURE_SETS.tools);
    await runReports(root, storePath);
    const database = await openDatabase(storePath);

    try {
      database.prepare("UPDATE tool_calls SET name = 'from-store'").run();
    } finally {
      database.close();
    }

    const tools = JSON.parse((await runReports(root, storePath)).tools) as {
      data: { rows: { name: string }[] };
    };

    expect(new Set(tools.data.rows.map((row) => row.name))).toEqual(new Set(['from-store']));
  });

  it('keeps the tool calls and turns of a departed file', async () => {
    const root = path.join(environment.rootDir, 'departed');
    const storePath = path.join(environment.rootDir, 'departed.db');
    await cp(path.resolve(FIXTURE_SETS.tools), root, { recursive: true });

    // Custom directories get history only with --history.
    const before = await runReports(root, storePath, { history: true });
    await rm(path.join(root, 'codex', 'session.jsonl'));
    const after = await runReports(root, storePath, { history: true });
    const withoutStore = await runReports(root);

    expect(Object.keys(before).filter((key) => key.startsWith('codex:'))).not.toEqual([]);
    expect(after).toEqual(before);
    // The departed file is still the session's, as history serves it.
    const departedPaths = Object.entries(
      await readSessionFilePaths(root, storePath, { history: true }),
    ).filter(([key]) => key.startsWith('codex:'));
    expect(departedPaths.map(([, paths]) => paths)).toEqual([
      [path.join(root, 'codex', 'session.jsonl')],
    ]);
    expect(Object.keys(withoutStore).some((key) => key.startsWith('codex:'))).toBe(false);
  });

  it('re-ingests the files of a store written before it kept tool calls, and only those', async () => {
    const storePath = path.join(environment.rootDir, 'upgrade.db');
    const root = path.resolve(FIXTURE_SETS.e2e);
    const expected = await runReports(root);
    await runReports(root, storePath);

    // As v4 left it: no tool call or message tables, fingerprints without stored kinds.
    // A sentinel skipped-row count marks what a later run rewrites.
    const store = await openEventStore(storePath);
    const files = listStoredFileFingerprints(store).map((file) => ({
      ...file,
      fingerprint: file.fingerprint.replace('"storedKinds":["message","tool_call"],', ''),
      events: readFileEvents(store, file.source, file.filePath) ?? [],
      skippedRows: 99,
    }));
    closeEventStore(store);
    await rm(storePath);
    await writeV4Store(storePath, files);

    expect(await runReports(root, storePath)).toEqual(expected);

    const reopened = await openDatabase(storePath);

    try {
      const files = reopened
        .prepare('SELECT source, skipped_rows, fingerprint FROM files ORDER BY source')
        .all();

      expect(files.map((file) => [file.source, file.skipped_rows === 99])).toEqual([
        ['claude', false],
        ['codex', false],
        ['gemini', true],
        ['pi', false],
      ]);
      expect(
        files.every(
          (file) =>
            file.source === 'gemini' ||
            String(file.fingerprint).includes('"storedKinds":["message","tool_call"]'),
        ),
      ).toBe(true);
    } finally {
      reopened.close();
    }
  });
});
