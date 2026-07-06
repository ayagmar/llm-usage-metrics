import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultAntigravityConversationsDir } from '../../src/sources/antigravity/antigravity-path-resolver.js';
import { AntigravitySourceAdapter } from '../../src/sources/antigravity/antigravity-source-adapter.js';
import {
  createAntigravityFixtureDb,
  loadAntigravityFixtureDatabaseSync,
} from '../helpers/antigravity-fixtures.js';

const tempDirs: string[] = [];
const DatabaseSync = loadAntigravityFixtureDatabaseSync();

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('getDefaultAntigravityConversationsDir', () => {
  it('uses GEMINI_CLI_HOME before the default .gemini directory', () => {
    expect(
      getDefaultAntigravityConversationsDir({
        homeDir: '/home/tester',
        env: { GEMINI_CLI_HOME: '/custom/gemini' },
      }),
    ).toBe(path.join('/custom/gemini', 'antigravity-cli', 'conversations'));

    expect(
      getDefaultAntigravityConversationsDir({
        homeDir: '/home/tester',
        env: { GEMINI_CLI_HOME: '   ' },
      }),
    ).toBe(path.join('/home/tester', '.gemini', 'antigravity-cli', 'conversations'));
  });
});

describe.skipIf(!DatabaseSync)('AntigravitySourceAdapter', () => {
  it('parses turn usage from protobuf blobs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-source-adapter-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'conversation-a.db');

    createAntigravityFixtureDb(dbPath, {
      turns: [
        {
          model: 'gemini-3-pro',
          timestamp: { seconds: 1_775_044_800, nanos: 123_000_000 },
          usage: {
            fixedInputTokens: 1_132,
            inputTokens: 68,
            cacheReadTokens: 20,
            outputTokens: 30,
            reasoningTokens: 9,
            responseId: 'response-a',
          },
        },
      ],
    });

    const adapter = new AntigravitySourceAdapter({ conversationsDir: tempDir });
    const diagnostics = await adapter.parseFileWithDiagnostics(dbPath);

    expect(diagnostics).toMatchObject({
      skippedRows: 0,
      skippedRowReasons: [],
    });
    expect(diagnostics.events).toHaveLength(1);
    expect(diagnostics.events[0]).toMatchObject({
      source: 'antigravity',
      sessionId: 'conversation-a',
      timestamp: '2026-04-01T12:00:00.123Z',
      provider: undefined,
      model: 'gemini-3-pro',
      inputTokens: 1_200,
      outputTokens: 30,
      reasoningTokens: 9,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      totalTokens: 1_259,
      costMode: 'estimated',
    });
  });

  it('uses session metadata as a timestamp fallback', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-session-fallback-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'fallback.db');

    createAntigravityFixtureDb(dbPath, {
      sessionCreatedAt: { seconds: 1_775_131_200 },
      turns: [
        {
          model: 'gemini-fallback',
          usage: {
            fixedInputTokens: 10,
            inputTokens: 5,
            outputTokens: 4,
            responseId: 'fallback-response',
          },
        },
      ],
    });

    const adapter = new AntigravitySourceAdapter();
    const events = await adapter.parseFile(dbPath);

    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe('2026-04-02T12:00:00.000Z');
    expect(events[0]).toMatchObject({
      sessionId: 'fallback',
      inputTokens: 15,
      outputTokens: 4,
    });
  });

  it('deduplicates repeated response ids and records skip reasons', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-diagnostics-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'diagnostics.db');

    createAntigravityFixtureDb(dbPath, {
      turns: [
        {
          model: 'gemini-first',
          timestamp: { seconds: 1_775_044_800 },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            responseId: 'same-response',
          },
        },
        {
          model: 'gemini-duplicate',
          timestamp: { seconds: 1_775_044_801 },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            responseId: 'same-response',
          },
        },
        {
          model: 'gemini-zero',
          timestamp: { seconds: 1_775_044_802 },
          usage: {
            fixedInputTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            responseId: 'zero-response',
          },
        },
        {
          model: 'gemini-no-time',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            responseId: 'no-time-response',
          },
        },
        {
          rawBlob: new Uint8Array([0x08, 0x80]),
        },
      ],
    });

    const adapter = new AntigravitySourceAdapter();
    const diagnostics = await adapter.parseFileWithDiagnostics(dbPath);

    expect(diagnostics.events.map((event) => event.model)).toEqual(['gemini-first']);
    expect(diagnostics.skippedRows).toBe(3);
    expect(diagnostics.skippedRowReasons).toEqual([
      { reason: 'invalid_payload', count: 1 },
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
  });

  it('treats DBs without gen_metadata as empty non-Antigravity files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-empty-db-'));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, 'not-antigravity.db');

    createAntigravityFixtureDb(dbPath, {
      createGenMetadataTable: false,
      sessionCreatedAt: { seconds: 1_775_044_800 },
    });

    const adapter = new AntigravitySourceAdapter();

    await expect(adapter.parseFileWithDiagnostics(dbPath)).resolves.toEqual({
      events: [],
      skippedRows: 0,
      skippedRowReasons: [],
    });
  });

  it('discovers non-recursive .db files from explicit and default conversation directories', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-discovery-'));
    tempDirs.push(tempDir);
    const explicitDir = path.join(tempDir, 'explicit');
    const nestedDir = path.join(explicitDir, 'nested');
    const defaultDir = path.join(tempDir, '.gemini', 'antigravity-cli', 'conversations');
    const explicitDbPath = path.join(explicitDir, 'explicit.db');
    const defaultDbPath = path.join(defaultDir, 'default.db');
    await mkdir(nestedDir, { recursive: true });
    await mkdir(defaultDir, { recursive: true });
    await writeFile(explicitDbPath, '', 'utf8');
    await writeFile(path.join(explicitDir, 'not-db.txt'), '', 'utf8');
    await writeFile(path.join(nestedDir, 'nested.db'), '', 'utf8');
    await writeFile(defaultDbPath, '', 'utf8');

    const explicitAdapter = new AntigravitySourceAdapter({
      conversationsDir: explicitDir,
      requireConversationsDir: true,
    });
    const defaultAdapter = new AntigravitySourceAdapter({
      homeDir: tempDir,
      env: {},
    });

    await expect(explicitAdapter.discoverFiles()).resolves.toEqual([
      await realpath(explicitDbPath),
    ]);
    await expect(defaultAdapter.discoverFiles()).resolves.toEqual([await realpath(defaultDbPath)]);
  });

  it('returns no discovered files when the default conversation directory is missing', async () => {
    const adapter = new AntigravitySourceAdapter({
      homeDir: path.join(os.tmpdir(), `missing-antigravity-${Date.now()}`),
      env: {},
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([]);
  });

  it('fails discovery when explicit conversation directory is blank, missing, or not a directory', async () => {
    const blankAdapter = new AntigravitySourceAdapter({
      conversationsDir: '   ',
      requireConversationsDir: true,
    });

    await expect(blankAdapter.discoverFiles()).rejects.toThrow(
      'Antigravity conversations directory must be a non-empty path',
    );

    const missingAdapter = new AntigravitySourceAdapter({
      conversationsDir: path.join(os.tmpdir(), `missing-antigravity-${Date.now()}`),
      requireConversationsDir: true,
    });

    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'Antigravity conversations directory is missing or unreadable',
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'antigravity-file-dir-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'conversation.db');
    await writeFile(filePath, '', 'utf8');
    const fileAdapter = new AntigravitySourceAdapter({
      conversationsDir: filePath,
      requireConversationsDir: true,
    });

    await expect(fileAdapter.discoverFiles()).rejects.toThrow(
      `Antigravity conversations directory is not a directory: ${filePath}`,
    );
  });

  it('validates parse DB paths before opening sqlite', async () => {
    const adapter = new AntigravitySourceAdapter();

    await expect(adapter.parseFileWithDiagnostics('   ')).rejects.toThrow(
      'Antigravity DB path must be a non-empty path',
    );

    const unreadableAdapter = new AntigravitySourceAdapter({
      pathReadable: async () => false,
    });

    await expect(unreadableAdapter.parseFileWithDiagnostics('/tmp/antigravity.db')).rejects.toThrow(
      'Antigravity DB path is unreadable: /tmp/antigravity.db',
    );

    const directoryAdapter = new AntigravitySourceAdapter({
      pathExists: async () => true,
      pathReadable: async () => true,
      pathIsFile: async () => false,
    });

    await expect(directoryAdapter.parseFileWithDiagnostics('/tmp/antigravity-dir')).rejects.toThrow(
      'Antigravity DB path is not a file: /tmp/antigravity-dir',
    );
  });

  it('reports sqlite sidecars as parse dependencies', async () => {
    const adapter = new AntigravitySourceAdapter();

    await expect(adapter.getParseDependencies('/tmp/conversation.db')).resolves.toEqual([
      '/tmp/conversation.db-wal',
      '/tmp/conversation.db-shm',
      '/tmp/conversation.db-journal',
    ]);
    await expect(adapter.getParseDependencies('   ')).resolves.toEqual([]);
  });
});
