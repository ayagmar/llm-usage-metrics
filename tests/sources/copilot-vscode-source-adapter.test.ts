import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CopilotVscodeSourceAdapter } from '../../src/sources/copilot-vscode/copilot-vscode-source-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRootDir = path.join(__dirname, '..', 'fixtures', 'copilot-vscode', 'workspaceStorage');

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('CopilotVscodeSourceAdapter', () => {
  it('exposes stable source id', () => {
    const adapter = new CopilotVscodeSourceAdapter();

    expect(adapter.id).toBe('copilot-vscode');
  });

  it('discovers only */chatSessions/*.json under explicit root', async () => {
    const adapter = new CopilotVscodeSourceAdapter({
      workspaceStorageDir: fixturesRootDir,
      requireWorkspaceStorageDir: true,
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([
      path.join(fixturesRootDir, 'hash-a', 'chatSessions', 'session-basic.json'),
      path.join(fixturesRootDir, 'hash-b', 'chatSessions', 'session-multi-model.json'),
      path.join(fixturesRootDir, 'hash-c', 'chatSessions', 'session-empty-requests.json'),
      path.join(fixturesRootDir, 'hash-d', 'chatSessions', 'session-invalid-entries.json'),
    ]);
  });

  it('merges sessions from multiple existing default roots when not explicitly configured', async () => {
    const tempHomeDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-vscode-home-'));
    tempDirs.push(tempHomeDir);

    const stableDir = path.join(tempHomeDir, '.config', 'Code', 'User', 'workspaceStorage');
    const insidersDir = path.join(
      tempHomeDir,
      '.config',
      'Code - Insiders',
      'User',
      'workspaceStorage',
    );

    const stableSession = path.join(stableDir, 'hash-a', 'chatSessions', 'stable.json');
    const insidersSession = path.join(insidersDir, 'hash-b', 'chatSessions', 'insiders.json');
    await mkdir(path.dirname(stableSession), { recursive: true });
    await mkdir(path.dirname(insidersSession), { recursive: true });
    await writeFile(stableSession, '{"requests":[]}', 'utf8');
    await writeFile(insidersSession, '{"requests":[]}', 'utf8');

    const adapter = new CopilotVscodeSourceAdapter({
      platform: 'linux',
      homeDir: tempHomeDir,
      env: {},
    });

    await expect(adapter.discoverFiles()).resolves.toEqual([insidersSession, stableSession].sort());
  });

  it('throws for explicit missing workspaceStorage directory', async () => {
    const adapter = new CopilotVscodeSourceAdapter({
      workspaceStorageDir: path.join(os.tmpdir(), `missing-copilot-vscode-${Date.now()}`),
      requireWorkspaceStorageDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      'Copilot VS Code workspaceStorage directory is missing or unreadable',
    );
  });

  it('throws for explicit non-directory workspaceStorage path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'copilot-vscode-file-path-'));
    tempDirs.push(tempDir);
    const nonDirectoryPath = path.join(tempDir, 'session.json');
    await writeFile(nonDirectoryPath, '{}', 'utf8');

    const adapter = new CopilotVscodeSourceAdapter({
      workspaceStorageDir: nonDirectoryPath,
      requireWorkspaceStorageDir: true,
    });

    await expect(adapter.discoverFiles()).rejects.toThrow(
      `Copilot VS Code workspaceStorage directory is not a directory: ${nonDirectoryPath}`,
    );
  });

  it('parses one event per valid request with zero-token estimated payload', async () => {
    const adapter = new CopilotVscodeSourceAdapter();
    const filePath = path.join(fixturesRootDir, 'hash-b', 'chatSessions', 'session-multi-model.json');

    const events = await adapter.parseFile(filePath);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: 'copilot-vscode',
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
});
