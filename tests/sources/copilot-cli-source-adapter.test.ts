import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CopilotCliSourceAdapter,
  getDefaultCopilotCliSessionsDir,
} from '../../src/sources/copilot-cli/copilot-cli-source-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'copilot-cli');

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('CopilotCliSourceAdapter', () => {
  it('exposes stable source id and default directory', () => {
    const adapter = new CopilotCliSourceAdapter();

    expect(adapter.id).toBe('copilot-cli');
    expect(path.basename(getDefaultCopilotCliSessionsDir())).toBe('session-state');
    expect(path.isAbsolute(getDefaultCopilotCliSessionsDir())).toBe(true);
  });

  it('discovers flat and directory sessions and ignores non-target files', async () => {
    const adapter = new CopilotCliSourceAdapter({ sessionsDir: fixturesDir });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      path.join(fixturesDir, 'session-dir', 'events.jsonl'),
      path.join(fixturesDir, 'session-flat.jsonl'),
      path.join(fixturesDir, 'session-no-cwd.jsonl'),
      path.join(fixturesDir, 'session-with-orphan-turn-end.jsonl'),
      path.join(fixturesDir, 'session-with-truncation', 'events.jsonl'),
    ]);
  });

  it('throws for explicit missing directory', async () => {
    const adapter = new CopilotCliSourceAdapter({
      sessionsDir: path.join(os.tmpdir(), `missing-copilot-cli-${Date.now()}`),
      requireSessionsDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'Copilot CLI sessions directory is missing or unreadable',
    );
  });

  it('throws for explicit non-directory path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-cli-file-path-'));
    tempDirs.push(tempDir);
    const nonDirectoryPath = path.join(tempDir, 'session.jsonl');
    await writeFile(nonDirectoryPath, '{}\n', 'utf8');

    const adapter = new CopilotCliSourceAdapter({
      sessionsDir: nonDirectoryPath,
      requireSessionsDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      `Copilot CLI sessions directory is not a directory: ${nonDirectoryPath}`,
    );
  });

  it('parses events with zero-token estimated payload', async () => {
    const adapter = new CopilotCliSourceAdapter({ sessionsDir: fixturesDir });
    const filePath = path.join(fixturesDir, 'session-flat.jsonl');

    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: 'copilot-cli',
      provider: 'github',
      costMode: 'estimated',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
  });

  it('returns parse diagnostics with skipped row reason counts', async () => {
    const adapter = new CopilotCliSourceAdapter({ sessionsDir: fixturesDir });
    const filePath = path.join(fixturesDir, 'session-with-truncation', 'events.jsonl');

    const result = await adapter.parseFileWithDiagnostics(filePath);

    expect(result.events).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
    expect(result.skippedRowReasons).toEqual([{ reason: 'unsupported_event_type', count: 1 }]);
  });
});
