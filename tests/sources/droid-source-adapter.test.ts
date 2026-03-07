import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DroidSourceAdapter,
  getDefaultDroidSessionsDir,
} from '../../src/sources/droid/droid-source-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'droid');

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('DroidSourceAdapter', () => {
  it('exposes stable source id and default directory', () => {
    const adapter = new DroidSourceAdapter();

    expect(adapter.id).toBe('droid');
    expect(path.basename(getDefaultDroidSessionsDir())).toBe('sessions');
    expect(path.isAbsolute(getDefaultDroidSessionsDir())).toBe(true);
  });

  describe('discoverFiles', () => {
    it('discovers *.settings.json recursively', async () => {
      const sessionsDir = path.join(fixturesDir, 'sessions');
      const adapter = new DroidSourceAdapter({ sessionsDir });

      await expect(adapter.discoverFiles()).resolves.toEqual([
        path.join(sessionsDir, 'nested', 'root-b.settings.json'),
        path.join(sessionsDir, 'root-a.settings.json'),
      ]);
    });

    it('validates explicit directory overrides', async () => {
      const blankAdapter = new DroidSourceAdapter({
        sessionsDir: '   ',
        requireSessionsDir: true,
      });
      await expect(blankAdapter.discoverFiles()).rejects.toThrow(
        'Droid sessions directory must be a non-empty path',
      );

      const missingPath = path.join(os.tmpdir(), `missing-droid-${Date.now()}`);
      const missingAdapter = new DroidSourceAdapter({
        sessionsDir: missingPath,
        requireSessionsDir: true,
      });
      await expect(missingAdapter.discoverFiles()).rejects.toThrow(
        'Droid sessions directory is missing or unreadable',
      );

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'droid-file-path-'));
      tempDirs.push(tempDir);
      const filePath = path.join(tempDir, 'not-a-dir.settings.json');
      await writeFile(filePath, '{}', 'utf8');

      const fileAdapter = new DroidSourceAdapter({
        sessionsDir: filePath,
        requireSessionsDir: true,
      });
      await expect(fileAdapter.discoverFiles()).rejects.toThrow(
        `Droid sessions directory is not a directory: ${filePath}`,
      );
    });
  });

  describe('parseFile', () => {
    it('parses settings-only sessions and computes billable totalTokens', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const filePath = path.join(fixturesDir, 'parsing', 'settings-only.settings.json');
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        source: 'droid',
        sessionId: 'settings-only',
        provider: 'openai',
        model: 'gpt-4.1',
        timestamp: '2026-02-24T10:00:00.000Z',
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 20,
        costMode: 'estimated',
      });
    });

    it('enriches repoRoot from sibling JSONL session_start', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const filePath = path.join(fixturesDir, 'parsing', 'with-jsonl.settings.json');
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(1);
      expect(events[0]?.repoRoot).toBe('/home/user/projects/my-app');
    });

    it('falls back to first JSONL message timestamp when settings timestamp is missing', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const filePath = path.join(fixturesDir, 'parsing', 'fallback-timestamp.settings.json');
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe('2026-02-24T10:00:11.000Z');
      expect(events[0]?.repoRoot).toBe('/home/user/projects/fallback-repo');
    });

    it('accepts numeric-string epoch timestamps from settings metadata', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'droid-epoch-string-'));
      tempDirs.push(tempDir);
      const settingsPath = path.join(tempDir, 'epoch-string.settings.json');

      await writeFile(
        settingsPath,
        JSON.stringify({
          providerLock: 'openai',
          model: 'gpt-4.1',
          providerLockTimestamp: '1707768000',
          tokenUsage: {
            inputTokens: 1,
            outputTokens: 1,
            thinkingTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
        'utf8',
      );

      const events = await adapter.parseFile(settingsPath);

      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe('2024-02-12T20:00:00.000Z');
    });

    it('skips invalid fallback message timestamps and keeps scanning for a valid one', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'droid-fallback-scan-'));
      tempDirs.push(tempDir);
      const settingsPath = path.join(tempDir, 'fallback-scan.settings.json');
      const jsonlPath = path.join(tempDir, 'fallback-scan.jsonl');

      await writeFile(
        settingsPath,
        JSON.stringify({
          providerLock: 'openai',
          model: 'gpt-4.1',
          tokenUsage: {
            inputTokens: 1,
            outputTokens: 1,
            thinkingTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
        'utf8',
      );
      await writeFile(
        jsonlPath,
        [
          JSON.stringify({ type: 'session_start', session_start: { cwd: '/tmp/repo' } }),
          JSON.stringify({ type: 'message', timestamp: 'not-a-timestamp' }),
          JSON.stringify({ type: 'message', timestamp: '2026-02-24T10:00:22.000Z' }),
        ].join('\n'),
        'utf8',
      );

      const events = await adapter.parseFile(settingsPath);
      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe('2026-02-24T10:00:22.000Z');
      expect(events[0]?.repoRoot).toBe('/tmp/repo');
    });

    it('fails open when sibling JSONL is missing, unreadable, or malformed', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });

      const missingJsonlEvents = await adapter.parseFile(
        path.join(fixturesDir, 'parsing', 'settings-only.settings.json'),
      );
      expect(missingJsonlEvents).toHaveLength(1);

      const malformedJsonlEvents = await adapter.parseFile(
        path.join(fixturesDir, 'parsing', 'malformed-jsonl.settings.json'),
      );
      expect(malformedJsonlEvents).toHaveLength(1);

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'droid-unreadable-jsonl-'));
      tempDirs.push(tempDir);
      const settingsPath = path.join(tempDir, 'unreadable.settings.json');
      const jsonlPath = path.join(tempDir, 'unreadable.jsonl');
      await writeFile(
        settingsPath,
        JSON.stringify({
          providerLock: 'openai',
          model: 'gpt-4.1',
          providerLockTimestamp: '2026-02-24T10:00:00.000Z',
          tokenUsage: {
            inputTokens: 1,
            outputTokens: 1,
            thinkingTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
        'utf8',
      );
      await writeFile(jsonlPath, '{"type":"session_start"}\n', 'utf8');
      await chmod(jsonlPath, 0);

      const events = await adapter.parseFile(settingsPath);
      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe('2026-02-24T10:00:00.000Z');
    });

    it('stops JSONL scan after session_start when primary timestamp is valid', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const events = await adapter.parseFile(
        path.join(fixturesDir, 'parsing', 'early-exit.settings.json'),
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.repoRoot).toBeUndefined();
    });

    it('keeps reasoning-only sessions even when billable totals are zero', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const events = await adapter.parseFile(
        path.join(fixturesDir, 'parsing', 'reasoning-only.settings.json'),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10,
      });
    });
  });

  describe('parseFileWithDiagnostics', () => {
    it('reports parse errors and invalid shapes', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });

      const malformed = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'parsing', 'invalid-json.txt'),
      );
      expect(malformed.events).toHaveLength(0);
      expect(malformed.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);

      const invalidRoot = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'parsing', 'invalid-root.settings.json'),
      );
      expect(invalidRoot.events).toHaveLength(0);
      expect(invalidRoot.skippedRowReasons).toEqual([
        { reason: 'invalid_settings_data', count: 1 },
      ]);
    });

    it('reports missing/zero usage as no_token_usage', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });

      const missingUsage = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'parsing', 'missing-token-usage.settings.json'),
      );
      expect(missingUsage.events).toHaveLength(0);
      expect(missingUsage.skippedRowReasons).toEqual([{ reason: 'no_token_usage', count: 1 }]);
    });

    it('reports explicit zero token usage as no_token_usage', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'droid-zero-usage-'));
      tempDirs.push(tempDir);
      const settingsPath = path.join(tempDir, 'zero-usage.settings.json');

      await writeFile(
        settingsPath,
        JSON.stringify({
          providerLock: 'openai',
          model: 'gpt-4.1',
          providerLockTimestamp: '2026-02-24T10:00:00.000Z',
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
        'utf8',
      );

      const result = await adapter.parseFileWithDiagnostics(settingsPath);

      expect(result.events).toHaveLength(0);
      expect(result.skippedRowReasons).toEqual([{ reason: 'no_token_usage', count: 1 }]);
    });

    it('reports invalid timestamp rows when neither primary nor fallback are valid', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'parsing', 'invalid-timestamp.settings.json'),
      );

      expect(result.events).toHaveLength(0);
      expect(result.skippedRowReasons).toEqual([{ reason: 'invalid_timestamp', count: 1 }]);
    });

    it('reports event creation failures when sessionId is invalid', async () => {
      const adapter = new DroidSourceAdapter({ sessionsDir: fixturesDir });
      Object.defineProperty(adapter, 'id', { value: '   ' });
      const result = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'parsing', 'settings-only.settings.json'),
      );

      expect(result.events).toHaveLength(0);
      expect(result.skippedRowReasons).toEqual([{ reason: 'event_creation_failed', count: 1 }]);
    });
  });
});
