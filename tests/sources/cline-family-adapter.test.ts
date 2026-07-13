import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLINE_EXTENSION_IDS,
  createClineFamilyAdapter,
  getDefaultClineTaskRootCandidates,
} from '../../src/sources/cline/cline-family-adapter.js';
import { getClineTaskHistoryPath } from '../../src/sources/cline/cline-task-parser.js';

const fixtureTasksDir = path.resolve('tests/fixtures/cline/tasks');
const fixtureUiMessagesPath = path.join(fixtureTasksDir, 'task-a', 'ui_messages.json');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function writeUiMessagesFile(rootDir: string, taskId: string): Promise<string> {
  const filePath = path.join(rootDir, taskId, 'ui_messages.json');

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '[]', 'utf8');

  return filePath;
}

describe('getDefaultClineTaskRootCandidates', () => {
  it('resolves Linux local and remote VS Code task roots', () => {
    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.cline,
        platform: 'linux',
        homeDir: '/home/tester',
        env: {},
      }),
    ).toEqual([
      path.join(
        '/home/tester',
        '.config',
        'Code',
        'User',
        'globalStorage',
        CLINE_EXTENSION_IDS.cline,
        'tasks',
      ),
      path.join(
        '/home/tester',
        '.vscode-server',
        'data',
        'User',
        'globalStorage',
        CLINE_EXTENSION_IDS.cline,
        'tasks',
      ),
    ]);
  });

  it('resolves macOS and Windows local VS Code roots', () => {
    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.cline,
        platform: 'darwin',
        homeDir: '/Users/tester',
        env: {},
      })[0],
    ).toBe(
      path.join(
        '/Users/tester',
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        CLINE_EXTENSION_IDS.cline,
        'tasks',
      ),
    );

    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.cline,
        platform: 'win32',
        homeDir: '/home/tester',
        env: { APPDATA: '/roaming' },
      })[0],
    ).toBe(
      path.join('/roaming', 'Code', 'User', 'globalStorage', CLINE_EXTENSION_IDS.cline, 'tasks'),
    );
  });

  it('uses source-specific extension ids in default roots', () => {
    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.roocode,
        platform: 'linux',
        homeDir: '/home/tester',
        env: {},
      })[0],
    ).toBe(
      path.join(
        '/home/tester',
        '.config',
        'Code',
        'User',
        'globalStorage',
        CLINE_EXTENSION_IDS.roocode,
        'tasks',
      ),
    );

    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.kilocode,
        platform: 'linux',
        homeDir: '/home/tester',
        env: {},
      })[0],
    ).toBe(
      path.join(
        '/home/tester',
        '.config',
        'Code',
        'User',
        'globalStorage',
        CLINE_EXTENSION_IDS.kilocode,
        'tasks',
      ),
    );
  });
});

describe('ClineFamilyAdapter', () => {
  it('discovers ui_messages.json files from default roots only', async () => {
    const rootA = await mkdtemp(path.join(os.tmpdir(), 'cline-root-a-'));
    const rootB = await mkdtemp(path.join(os.tmpdir(), 'cline-root-b-'));
    tempDirs.push(rootA, rootB);

    const fileA = await writeUiMessagesFile(rootA, 'task-a');
    const fileB = await writeUiMessagesFile(rootB, 'task-b');
    await writeFile(path.join(rootA, 'other.json'), '{}', 'utf8');

    const adapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
      defaultRootDirs: [rootB, rootA, path.join(rootA, 'missing')],
    });

    const expectedFiles = [await realpath(fileA), await realpath(fileB)].sort();

    await expect(adapter.discoverFiles()).resolves.toEqual(expectedFiles);
  });

  it('validates explicit task directory overrides', async () => {
    const blankAdapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
      dir: '   ',
      requireDir: true,
    });
    await expect(blankAdapter.discoverFiles()).rejects.toThrow(
      'cline tasks directory must be a non-empty path',
    );

    const missingPath = path.join(os.tmpdir(), `missing-cline-${Date.now()}`);
    const missingAdapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
      dir: missingPath,
      requireDir: true,
    });
    await expect(missingAdapter.discoverFiles()).rejects.toThrow(
      'cline tasks directory is missing or unreadable',
    );

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cline-file-path-'));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, 'ui_messages.json');
    await writeFile(filePath, '[]', 'utf8');

    const fileAdapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
      dir: filePath,
      requireDir: true,
    });
    await expect(fileAdapter.discoverFiles()).rejects.toThrow(
      `cline tasks directory is not a directory: ${filePath}`,
    );
  });

  it('reports sibling history as a parse dependency', async () => {
    const adapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
    });

    await expect(adapter.getParseDependencies(fixtureUiMessagesPath)).resolves.toEqual([
      getClineTaskHistoryPath(fixtureUiMessagesPath),
    ]);
  });

  it('parses Cline task usage and diagnostics', async () => {
    const adapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
    });

    const result = await adapter.parseFileWithDiagnostics(fixtureUiMessagesPath);

    expect(result.skippedRows).toBe(3);
    expect(result.skippedRowReasons).toEqual([
      { reason: 'invalid_payload', count: 1 },
      { reason: 'invalid_timestamp', count: 1 },
      { reason: 'no_token_usage', count: 1 },
    ]);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      source: 'cline',
      sessionId: 'task-a',
      timestamp: '2026-03-02T10:00:00.000Z',
      provider: 'anthropic',
      model: 'claude-3.7-sonnet',
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 165,
      costUsd: 0.25,
      costMode: 'explicit',
    });
    expect(result.events[1]).toMatchObject({
      source: 'cline',
      sessionId: 'task-a',
      timestamp: '2026-03-02T10:01:00.000Z',
      provider: 'openai',
      model: 'claude-3.7-sonnet',
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      costMode: 'estimated',
    });
    expect(result.events[1]?.costUsd).toBeUndefined();
  });
});
