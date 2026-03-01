import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverCopilotCliSessionFiles,
  getDefaultCopilotCliSessionsDir,
} from '../../src/sources/copilot-cli/copilot-cli-path-resolver.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('copilot-cli-path-resolver', () => {
  it('returns deterministic default sessions directory', () => {
    expect(path.basename(getDefaultCopilotCliSessionsDir())).toBe('session-state');
    expect(path.isAbsolute(getDefaultCopilotCliSessionsDir())).toBe(true);
  });

  it('discovers flat and nested events.jsonl files only', async () => {
    const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-cli-discover-'));
    tempDirs.push(sessionsDir);

    const nestedDir = path.join(sessionsDir, 'nested-session');
    await mkdir(nestedDir, { recursive: true });

    const flat = path.join(sessionsDir, 'a-flat.jsonl');
    const nestedEvents = path.join(nestedDir, 'events.jsonl');
    const ignoredNested = path.join(nestedDir, 'other.jsonl');
    const ignoredTxt = path.join(sessionsDir, 'readme.txt');

    await writeFile(flat, '{}\n', 'utf8');
    await writeFile(nestedEvents, '{}\n', 'utf8');
    await writeFile(ignoredNested, '{}\n', 'utf8');
    await writeFile(ignoredTxt, 'ignored', 'utf8');

    const files = await discoverCopilotCliSessionFiles({ sessionsDir });

    expect(files).toEqual([flat, nestedEvents].sort());
  });

  it('returns empty list for missing directory when not required', async () => {
    const files = await discoverCopilotCliSessionFiles({
      sessionsDir: path.join(os.tmpdir(), `missing-cli-sessions-${Date.now()}`),
    });

    expect(files).toEqual([]);
  });

  it('rethrows non-skippable read errors when not required', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-cli-enotdir-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'not-a-directory.jsonl');
    await writeFile(filePath, '{}\n', 'utf8');

    try {
      await discoverCopilotCliSessionFiles({
        sessionsDir: filePath,
        requireSessionsDir: false,
      });
      throw new Error('Expected discoverCopilotCliSessionFiles to reject');
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      expect(typeof code).toBe('string');
      expect(code).not.toBe('ENOENT');
      expect(code).not.toBe('EACCES');
      expect(code).not.toBe('EPERM');
    }
  });

  it('throws for blank explicit sessionsDir', async () => {
    await expect(discoverCopilotCliSessionFiles({ sessionsDir: '   ' })).rejects.toThrow(
      'Copilot CLI sessions directory must be a non-empty path',
    );
  });

  it('throws for explicit missing directory when required', async () => {
    await expect(
      discoverCopilotCliSessionFiles({
        sessionsDir: path.join(os.tmpdir(), `missing-cli-required-${Date.now()}`),
        requireSessionsDir: true,
      }),
    ).rejects.toThrow('Copilot CLI sessions directory is missing or unreadable');
  });

  it('throws for explicit non-directory path when required', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-cli-not-directory-'));
    tempDirs.push(tempDir);

    const nonDirectoryPath = path.join(tempDir, 'file.jsonl');
    await writeFile(nonDirectoryPath, '{}\n', 'utf8');

    await expect(
      discoverCopilotCliSessionFiles({
        sessionsDir: nonDirectoryPath,
        requireSessionsDir: true,
      }),
    ).rejects.toThrow(`Copilot CLI sessions directory is not a directory: ${nonDirectoryPath}`);
  });
});
