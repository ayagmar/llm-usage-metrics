import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GeminiSourceAdapter,
  getDefaultGeminiDir,
} from '../../src/sources/gemini/gemini-source-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'gemini');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('GeminiSourceAdapter', () => {
  it('exposes stable source id and default directory', () => {
    const adapter = new GeminiSourceAdapter();

    expect(adapter.id).toBe('gemini');
    expect(path.basename(getDefaultGeminiDir())).toBe('.gemini');
    expect(path.isAbsolute(getDefaultGeminiDir())).toBe(true);
  });

  describe('discoverFiles', () => {
    it('discovers only session files inside tmp/*/chats', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });

      await expect(adapter.discoverFiles()).resolves.toEqual([
        path.join(fixturesDir, 'tmp', 'legacy-project', 'chats', 'nested-no-project-hash.json'),
        path.join(fixturesDir, 'tmp', 'test-project', 'chats', 'nested-session.json'),
      ]);
    });

    it('returns empty array when tmp directory is missing', async () => {
      const adapter = new GeminiSourceAdapter({
        geminiDir: path.join(fixturesDir, 'missing-root'),
      });

      await expect(adapter.discoverFiles()).resolves.toEqual([]);
    });

    it('rethrows non-missing tmp directory errors', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-bad-tmp-'));
      tempDirs.push(tempDir);
      await writeFile(path.join(tempDir, 'tmp'), 'not-a-directory', 'utf8');

      const adapter = new GeminiSourceAdapter({ geminiDir: tempDir });

      await expect(adapter.discoverFiles()).rejects.toThrow();
    });

    it('validates explicit directory options', async () => {
      const blankDirAdapter = new GeminiSourceAdapter({ geminiDir: '   ' });
      await expect(blankDirAdapter.discoverFiles()).rejects.toThrow(
        'Gemini directory must be a non-empty path',
      );

      const missingRequiredDirAdapter = new GeminiSourceAdapter({
        geminiDir: path.join(fixturesDir, 'missing-root'),
        requireGeminiDir: true,
      });
      await expect(missingRequiredDirAdapter.discoverFiles()).rejects.toThrow(
        'Gemini directory is missing or unreadable',
      );
    });

    const itIfSymlinksSupported = process.platform === 'win32' ? it.skip : it;

    itIfSymlinksSupported(
      'discovers session files inside symlinked tmp project directories',
      async () => {
        const geminiDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-symlink-project-'));
        tempDirs.push(geminiDir);

        const externalProjectDir = await mkdtemp(
          path.join(os.tmpdir(), 'gemini-external-project-'),
        );
        tempDirs.push(externalProjectDir);

        const linkedProjectDir = path.join(geminiDir, 'tmp', 'project-link');
        const chatsDir = path.join(externalProjectDir, 'chats');
        const sessionFilePath = path.join(chatsDir, 'session.json');

        await mkdir(path.join(geminiDir, 'tmp'), { recursive: true });
        await mkdir(chatsDir, { recursive: true });
        await writeFile(sessionFilePath, '{"sessionId":"session-001","messages":[]}', 'utf8');
        await symlink(externalProjectDir, linkedProjectDir);

        const adapter = new GeminiSourceAdapter({ geminiDir });

        await expect(adapter.discoverFiles()).resolves.toEqual([
          path.join(linkedProjectDir, 'chats', 'session.json'),
        ]);
      },
    );
  });

  describe('parseFile', () => {
    it('parses usage and maps token fields correctly', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const filePath = path.join(fixturesDir, 'session-with-usage.json');
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(2);

      expect(events[0]).toMatchObject({
        source: 'gemini',
        sessionId: 'session-001',
        provider: 'google',
        model: 'gemini-3-flash-preview',
        timestamp: '2026-02-25T10:05:00.000Z',
        inputTokens: 105,
        outputTokens: 50,
        reasoningTokens: 25,
        cacheReadTokens: 10,
        totalTokens: 190,
        costMode: 'estimated',
        repoRoot: '/home/user/projects/my-app',
      });

      expect(events[1]).toMatchObject({
        inputTokens: 210,
        outputTokens: 100,
        reasoningTokens: 50,
        cacheReadTokens: 20,
        totalTokens: 380,
      });
    });

    it('computes total tokens when source total is missing', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const filePath = path.join(fixturesDir, 'session-no-project-hash.json');
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(1);
      expect(events[0].totalTokens).toBe(80);
    });

    it('accepts numeric-string epoch timestamps in message payloads', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-epoch-string-'));
      tempDirs.push(tempDir);
      const filePath = path.join(tempDir, 'epoch-string.json');

      await writeFile(
        filePath,
        JSON.stringify({
          sessionId: 'gemini-epoch-string',
          messages: [
            {
              type: 'gemini',
              model: 'gemini-3-flash-preview',
              timestamp: '1707768000',
              tokens: {
                input: 10,
                output: 5,
                thoughts: 2,
                cached: 1,
                total: 18,
              },
            },
          ],
        }),
        'utf8',
      );

      const adapter = new GeminiSourceAdapter({ geminiDir: tempDir });
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(1);
      expect(events[0]?.timestamp).toBe('2024-02-12T20:00:00.000Z');
    });

    it('does not fabricate repoRoot when project mapping is unavailable', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const filePath = path.join(fixturesDir, 'session-no-project-hash.json');
      const events = await adapter.parseFile(filePath);

      expect(events[0].repoRoot).toBeUndefined();
    });

    it('resolves repoRoot from tmp directory identifier when present in projects.json', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const filePath = path.join(
        fixturesDir,
        'tmp',
        'legacy-project',
        'chats',
        'nested-no-project-hash.json',
      );
      const events = await adapter.parseFile(filePath);

      expect(events).toHaveLength(1);
      expect(events[0].repoRoot).toBe('/home/user/projects/legacy');
    });

    it('skips messages without billable token usage', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });

      await expect(
        adapter.parseFile(path.join(fixturesDir, 'session-zero-tokens.json')),
      ).resolves.toHaveLength(0);
      await expect(
        adapter.parseFile(path.join(fixturesDir, 'session-no-tokens.json')),
      ).resolves.toHaveLength(0);
      await expect(
        adapter.parseFile(path.join(fixturesDir, 'session-invalid-token-types.json')),
      ).resolves.toHaveLength(0);
    });

    it('falls back to filename when sessionId is missing', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const events = await adapter.parseFile(
        path.join(fixturesDir, 'session-missing-sessionid.json'),
      );

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe('session-missing-sessionid');
    });

    it('can parse files even when geminiDir option is blank', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: '   ' });
      const events = await adapter.parseFile(path.join(fixturesDir, 'session-with-usage.json'));

      expect(events).toHaveLength(2);
      expect(events[0].repoRoot).toBeUndefined();
    });

    it('returns no parse dependencies when geminiDir is blank', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: '   ' });

      await expect(adapter.getParseDependencies()).resolves.toEqual([]);
    });

    it('returns projects.json as a parse dependency when geminiDir is configured', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });

      await expect(adapter.getParseDependencies()).resolves.toEqual([
        path.join(fixturesDir, 'projects.json'),
      ]);
    });

    it('reloads projects.json between parses on the same adapter instance', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-project-mapping-'));
      tempDirs.push(tempDir);

      const sessionFilePath = path.join(tempDir, 'session-with-usage.json');
      await writeFile(
        sessionFilePath,
        await readFile(path.join(fixturesDir, 'session-with-usage.json'), 'utf8'),
        'utf8',
      );

      const adapter = new GeminiSourceAdapter({ geminiDir: tempDir });

      await writeFile(
        path.join(tempDir, 'projects.json'),
        JSON.stringify({
          projects: {
            abc123: {
              absolutePath: '/tmp/first-repo',
            },
          },
        }),
        'utf8',
      );

      const firstParse = await adapter.parseFile(sessionFilePath);
      expect(firstParse[0]?.repoRoot).toBe('/tmp/first-repo');

      await writeFile(
        path.join(tempDir, 'projects.json'),
        JSON.stringify({
          projects: {
            abc123: {
              absolutePath: '/tmp/second-repo',
            },
          },
        }),
        'utf8',
      );

      const secondParse = await adapter.parseFile(sessionFilePath);
      expect(secondParse[0]?.repoRoot).toBe('/tmp/second-repo');
    });

    it('rethrows non-missing projects.json errors', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-project-errors-'));
      tempDirs.push(tempDir);

      const sessionFilePath = path.join(tempDir, 'session-with-usage.json');
      await writeFile(
        sessionFilePath,
        await readFile(path.join(fixturesDir, 'session-with-usage.json'), 'utf8'),
        'utf8',
      );
      await mkdir(path.join(tempDir, 'projects.json'));

      const adapter = new GeminiSourceAdapter({ geminiDir: tempDir });

      await expect(adapter.parseFile(sessionFilePath)).rejects.toThrow();
    });
  });

  describe('parseFileWithDiagnostics', () => {
    it('tracks skipped reason counts', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'session-with-usage.json'),
      );

      expect(result.events).toHaveLength(2);
      expect(result.skippedRows).toBe(1);
      expect(result.skippedRowReasons).toEqual([{ reason: 'non_gemini_message', count: 1 }]);
    });

    it('reports parse and shape errors', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });

      const malformed = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'invalid-json.txt'),
      );
      expect(malformed.skippedRowReasons).toEqual([{ reason: 'json_parse_error', count: 1 }]);

      const invalidRoot = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'session-invalid-root.json'),
      );
      expect(invalidRoot.skippedRowReasons).toEqual([{ reason: 'invalid_session_data', count: 1 }]);

      const invalidMessages = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'session-invalid-messages.json'),
      );
      expect(invalidMessages.skippedRowReasons).toEqual([
        { reason: 'invalid_messages_array', count: 1 },
      ]);

      const invalidTokenTypes = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'session-invalid-token-types.json'),
      );
      expect(invalidTokenTypes.skippedRowReasons).toEqual([{ reason: 'no_token_usage', count: 1 }]);
    });

    it('reports invalid timestamp rows', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(
        path.join(fixturesDir, 'session-invalid-timestamp.json'),
      );

      expect(result.events).toHaveLength(0);
      expect(result.skippedRowReasons).toEqual([{ reason: 'invalid_timestamp', count: 1 }]);
    });

    it('reports invalid message rows', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-invalid-message-'));
      tempDirs.push(tempDir);
      const filePath = path.join(tempDir, 'invalid-message.json');
      await writeFile(
        filePath,
        JSON.stringify({
          sessionId: 'session-invalid-message',
          messages: [null],
        }),
        'utf8',
      );

      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(filePath);

      expect(result.events).toHaveLength(0);
      expect(result.skippedRowReasons).toEqual([{ reason: 'invalid_message', count: 1 }]);
    });

    it('reports event creation failures when fallback sessionId is invalid', async () => {
      const adapter = new GeminiSourceAdapter({ geminiDir: fixturesDir });
      const result = await adapter.parseFileWithDiagnostics(path.join(fixturesDir, '   .json'));

      expect(result.events).toHaveLength(0);
      expect(result.skippedRows).toBe(1);
      expect(result.skippedRowReasons).toEqual([{ reason: 'event_creation_failed', count: 1 }]);
    });
  });
});
