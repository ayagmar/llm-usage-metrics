import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AmpSourceAdapter,
  getDefaultAmpThreadsDir,
} from '../../src/sources/amp/amp-source-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'amp');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function fixturePath(fileName: string): Promise<string> {
  return realpath(path.join(fixturesDir, fileName));
}

describe('AmpSourceAdapter', () => {
  it('exposes stable source id and XDG-aware default directory', () => {
    const adapter = new AmpSourceAdapter();

    expect(adapter.id).toBe('amp');
    expect(
      getDefaultAmpThreadsDir({
        homeDir: '/home/tester',
        env: { XDG_DATA_HOME: '/xdg-data' },
      }),
    ).toBe(path.join('/xdg-data', 'amp', 'threads'));
    expect(
      getDefaultAmpThreadsDir({
        homeDir: '/home/tester',
        env: { XDG_DATA_HOME: '   ' },
      }),
    ).toBe(path.join('/home/tester', '.local', 'share', 'amp', 'threads'));
  });

  describe('discoverFiles', () => {
    it('discovers JSON thread files', async () => {
      const adapter = new AmpSourceAdapter({ threadsDir: fixturesDir });

      await expect(adapter.discoverFiles()).resolves.toEqual([
        await fixturePath('both-thread.json'),
        await fixturePath('created-fallback-thread.json'),
        await fixturePath('diagnostics-thread.json'),
        await fixturePath('ledger-thread.json'),
        await fixturePath('legacy-messages-thread.json'),
      ]);
    });

    it('returns empty array when a default directory is missing', async () => {
      const adapter = new AmpSourceAdapter({
        threadsDir: path.join(fixturesDir, 'missing-root'),
      });

      await expect(adapter.discoverFiles()).resolves.toEqual([]);
    });

    it('validates explicit directory options', async () => {
      const blankDirAdapter = new AmpSourceAdapter({ threadsDir: '   ' });
      await expect(blankDirAdapter.discoverFiles()).rejects.toThrow(
        'Amp threads directory must be a non-empty path',
      );

      const missingRequiredDirAdapter = new AmpSourceAdapter({
        threadsDir: path.join(fixturesDir, 'missing-root'),
        requireThreadsDir: true,
      });
      await expect(missingRequiredDirAdapter.discoverFiles()).rejects.toThrow(
        'Amp threads directory is missing or unreadable',
      );
    });

    it('rejects explicit file paths', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'amp-file-path-'));
      tempDirs.push(tempDir);
      const filePath = path.join(tempDir, 'thread.json');
      await writeFile(filePath, '{}', 'utf8');

      const adapter = new AmpSourceAdapter({
        threadsDir: filePath,
        requireThreadsDir: true,
      });

      await expect(adapter.discoverFiles()).rejects.toThrow(
        `Amp threads directory is not a directory: ${filePath}`,
      );
    });
  });

  describe('parseFileWithDiagnostics', () => {
    it('parses ledger events, resolves cache tokens from messages, and ignores credits', async () => {
      const adapter = new AmpSourceAdapter({ threadsDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(
        await fixturePath('ledger-thread.json'),
      );

      expect(result.skippedRows).toBe(0);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toMatchObject({
        source: 'amp',
        sessionId: 'amp-ledger-thread',
        timestamp: '2026-02-25T12:05:00.000Z',
        model: 'claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 0,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        totalTokens: 190,
        costMode: 'estimated',
      });
      expect(result.events[0].costUsd).toBeUndefined();
      expect(result.events[1]).toMatchObject({
        model: 'gpt-5',
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 35,
      });
      expect(result.events.map((event) => event.model)).not.toContain('duplicate-ignored');
    });

    it('falls back to assistant message usage when the ledger is absent', async () => {
      const adapter = new AmpSourceAdapter({ threadsDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(
        await fixturePath('legacy-messages-thread.json'),
      );

      expect(result.skippedRows).toBe(0);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        source: 'amp',
        sessionId: 'amp-legacy-thread',
        timestamp: '2026-02-25T14:05:00.000Z',
        model: 'claude-haiku-4',
        inputTokens: 70,
        outputTokens: 25,
        cacheReadTokens: 5,
        cacheWriteTokens: 4,
        totalTokens: 104,
      });
    });

    it('prefers ledger events over message usage when both are present', async () => {
      const adapter = new AmpSourceAdapter({ threadsDir: fixturesDir });
      const events = await adapter.parseFile(await fixturePath('both-thread.json'));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sessionId: 'amp-both-thread',
        timestamp: '2026-02-26T09:35:00.000Z',
        model: 'ledger-model',
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      });
    });

    it('uses thread created timestamp when a usage entry timestamp is missing', async () => {
      const adapter = new AmpSourceAdapter({ threadsDir: fixturesDir });
      const events = await adapter.parseFile(await fixturePath('created-fallback-thread.json'));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        timestamp: '2026-02-27T10:00:00.000Z',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 4,
        cacheWriteTokens: 6,
        totalTokens: 13,
      });
    });

    it('reports zero-usage and bad-timestamp diagnostics', async () => {
      const adapter = new AmpSourceAdapter({ threadsDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(
        await fixturePath('diagnostics-thread.json'),
      );

      expect(result.events).toEqual([]);
      expect(result.skippedRows).toBe(3);
      expect(result.skippedRowReasons).toEqual([
        { reason: 'invalid_timestamp', count: 1 },
        { reason: 'no_token_usage', count: 2 },
      ]);
    });

    it('reports JSON parse failures', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'amp-invalid-json-'));
      tempDirs.push(tempDir);
      const filePath = path.join(tempDir, 'invalid.json');
      await writeFile(filePath, '{', 'utf8');

      const adapter = new AmpSourceAdapter({ threadsDir: tempDir });
      const result = await adapter.parseFileWithDiagnostics(filePath);

      expect(result.events).toEqual([]);
      expect(result.skippedRows).toBe(1);
      expect(result.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);
    });
  });
});
