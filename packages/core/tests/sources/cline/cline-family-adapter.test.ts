import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLINE_EXTENSION_IDS,
  createClineFamilyAdapter,
  getDefaultClineTaskRootCandidates,
} from '../../../src/sources/cline/cline-family-adapter.js';
import { getClineTaskHistoryPath } from '../../../src/sources/cline/cline-task-parser.js';
import { createSourceContext } from '../../../src/sources/source-context.js';
import * as kilocodeSource from '../../../src/sources/kilocode/index.js';
import * as roocodeSource from '../../../src/sources/roocode/index.js';
import { collect, collectFile } from '../../../src/stream/collect.js';
import { fixturePath } from '../../helpers/fixtures.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../../helpers/open-fds.js';

const fixtureTasksDir = fixturePath(import.meta.url, '../../fixtures/cline/tasks');
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
  it('resolves Linux VS Code, Cursor and remote VS Code task roots', () => {
    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.cline,
        context: createSourceContext({ platform: 'linux', homeDir: '/home/tester', env: {} }),
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
        '.config',
        'Cursor',
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
        context: createSourceContext({ platform: 'darwin', homeDir: '/Users/tester', env: {} }),
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
        context: createSourceContext({
          platform: 'win32',
          homeDir: '/home/tester',
          env: { APPDATA: '/roaming' },
        }),
      })[0],
    ).toBe(
      path.join('/roaming', 'Code', 'User', 'globalStorage', CLINE_EXTENSION_IDS.cline, 'tasks'),
    );
  });

  it('resolves Cursor beside VS Code on macOS and Windows', () => {
    const candidates = (context: ReturnType<typeof createSourceContext>) =>
      getDefaultClineTaskRootCandidates({ extensionId: CLINE_EXTENSION_IDS.roocode, context });
    const tasksDir = (appRoot: string) =>
      path.join(appRoot, 'User', 'globalStorage', CLINE_EXTENSION_IDS.roocode, 'tasks');

    expect(
      candidates(createSourceContext({ platform: 'darwin', homeDir: '/Users/tester', env: {} })),
    ).toEqual([
      tasksDir(path.join('/Users/tester', 'Library', 'Application Support', 'Code')),
      tasksDir(path.join('/Users/tester', 'Library', 'Application Support', 'Cursor')),
      tasksDir(path.join('/Users/tester', '.vscode-server', 'data')),
    ]);

    expect(
      candidates(
        createSourceContext({
          platform: 'win32',
          homeDir: '/home/tester',
          env: { APPDATA: '/roaming' },
        }),
      ).slice(0, 2),
    ).toEqual([tasksDir(path.join('/roaming', 'Code')), tasksDir(path.join('/roaming', 'Cursor'))]);

    expect(
      candidates(
        createSourceContext({ platform: 'win32', homeDir: '/home/tester', env: {} }),
      ).slice(0, 2),
    ).toEqual([
      tasksDir(path.join('/home/tester', 'AppData', 'Roaming', 'Code')),
      tasksDir(path.join('/home/tester', 'AppData', 'Roaming', 'Cursor')),
    ]);
  });

  it('finds Cursor beside an APPDATA that already names the VS Code dir', () => {
    const roots = getDefaultClineTaskRootCandidates({
      extensionId: CLINE_EXTENSION_IDS.cline,
      context: createSourceContext({
        platform: 'win32',
        homeDir: '/home/tester',
        env: { APPDATA: path.join('/roaming', 'Code') },
      }),
    });

    expect(roots.slice(0, 2)).toEqual([
      path.join('/roaming', 'Code', 'User', 'globalStorage', CLINE_EXTENSION_IDS.cline, 'tasks'),
      path.join('/roaming', 'Cursor', 'User', 'globalStorage', CLINE_EXTENSION_IDS.cline, 'tasks'),
    ]);
  });

  it('uses source-specific extension ids in default roots', () => {
    expect(
      getDefaultClineTaskRootCandidates({
        extensionId: CLINE_EXTENSION_IDS.roocode,
        context: createSourceContext({ platform: 'linux', homeDir: '/home/tester', env: {} }),
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
        context: createSourceContext({ platform: 'linux', homeDir: '/home/tester', env: {} }),
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

  it.each(['cline', 'roocode', 'kilocode'] as const)(
    'reads %s tasks from both VS Code and Cursor storage once each',
    async (id) => {
      const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cline-home-'));
      tempDirs.push(homeDir);
      const context = createSourceContext({ platform: 'linux', homeDir, env: {} });
      const tasksDir = (appDir: string) =>
        path.join(
          homeDir,
          '.config',
          appDir,
          'User',
          'globalStorage',
          CLINE_EXTENSION_IDS[id],
          'tasks',
        );
      const copyTask = async (appDir: string, taskId: string) => {
        const taskDir = path.join(tasksDir(appDir), taskId);
        await mkdir(taskDir, { recursive: true });
        await copyFile(fixtureUiMessagesPath, path.join(taskDir, 'ui_messages.json'));
        await copyFile(
          getClineTaskHistoryPath(fixtureUiMessagesPath),
          path.join(taskDir, 'api_conversation_history.json'),
        );
      };
      const singleTaskEvents = await collect(
        createClineFamilyAdapter({ id, extensionId: CLINE_EXTENSION_IDS[id] }).read(
          fixtureUiMessagesPath,
        ),
      );

      await copyTask('Cursor', 'task-cursor');
      const cursorOnly = createClineFamilyAdapter({
        id,
        extensionId: CLINE_EXTENSION_IDS[id],
        context,
      });
      const cursorFiles = await cursorOnly.discoverFiles();
      expect(cursorFiles).toEqual([
        await realpath(path.join(tasksDir('Cursor'), 'task-cursor', 'ui_messages.json')),
      ]);
      expect(singleTaskEvents.length).toBeGreaterThan(0);
      await expect(collect(cursorOnly.read(cursorFiles[0]))).resolves.toHaveLength(
        singleTaskEvents.length,
      );

      await copyTask('Code', 'task-code');
      const adapter = createClineFamilyAdapter({
        id,
        extensionId: CLINE_EXTENSION_IDS[id],
        context,
      });
      const files = await adapter.discoverFiles();
      expect(files).toEqual(
        [
          await realpath(path.join(tasksDir('Code'), 'task-code', 'ui_messages.json')),
          await realpath(path.join(tasksDir('Cursor'), 'task-cursor', 'ui_messages.json')),
        ].sort(),
      );
      const events = (await Promise.all(files.map((file) => collect(adapter.read(file))))).flat();
      expect(events).toHaveLength(singleTaskEvents.length * 2);
    },
  );

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

    const result = await collectFile(adapter, fixtureUiMessagesPath);

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
    });
    expect(result.events[1]?.costUsd).toBeUndefined();
  });

  it('finds the last model block in linear time despite unclosed tags', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cline-unclosed-tags-'));
    tempDirs.push(tempDir);
    const uiMessagesPath = path.join(tempDir, 'task-a', 'ui_messages.json');
    await mkdir(path.dirname(uiMessagesPath), { recursive: true });
    await copyFile(fixtureUiMessagesPath, uiMessagesPath);
    const history = JSON.parse(
      await readFile(getClineTaskHistoryPath(fixtureUiMessagesPath), 'utf8'),
    ) as unknown[];
    history.push({ role: 'user', content: '<environment_details>'.repeat(60_000) });
    await writeFile(getClineTaskHistoryPath(uiMessagesPath), JSON.stringify(history), 'utf8');

    const adapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
    });
    const startedAt = performance.now();
    const result = await collectFile(adapter, uiMessagesPath);

    expect(result.events[0]?.model).toBe('claude-3.7-sonnet');
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('splits cache tokens out of the cache-inclusive Roo and Kilo input counts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'roo-cache-inclusive-'));
    tempDirs.push(tempDir);
    const uiMessagesPath = path.join(tempDir, 'task-roo', 'ui_messages.json');
    await mkdir(path.dirname(uiMessagesPath), { recursive: true });
    const apiRequest = (ts: number, payload: Record<string, unknown>) => ({
      type: 'say',
      say: 'api_req_started',
      ts,
      text: JSON.stringify(payload),
    });
    await writeFile(
      uiMessagesPath,
      JSON.stringify([
        // Roo >= 3.30: tokensIn = input + cache writes + cache reads.
        apiRequest(1_772_445_600_000, {
          cost: 0.25,
          tokensIn: 10_500,
          tokensOut: 50,
          cacheReads: 9_000,
          cacheWrites: 500,
          apiProtocol: 'anthropic',
        }),
        // Older Roo rows carried the raw Anthropic count, which excludes cache tokens.
        apiRequest(1_772_445_660_000, {
          cost: 0,
          tokensIn: 1_000,
          tokensOut: 20,
          cacheReads: 9_000,
          cacheWrites: 500,
          apiProtocol: 'anthropic',
        }),
      ]),
      'utf8',
    );

    const subpaths = { roocode: roocodeSource, kilocode: kilocodeSource };
    for (const id of ['roocode', 'kilocode'] as const) {
      const source = subpaths[id];
      const adapter = source.createClineFamilyAdapter({
        id,
        extensionId: source.CLINE_EXTENSION_IDS[id],
      });
      const events = await collect(adapter.read(uiMessagesPath));

      expect(
        events.map((event) => ({
          inputTokens: event.inputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          totalTokens: event.totalTokens,
          costUsd: event.costUsd,
        })),
      ).toEqual([
        {
          inputTokens: 1_000,
          cacheReadTokens: 9_000,
          cacheWriteTokens: 500,
          totalTokens: 10_550,
          costUsd: 0.25,
        },
        {
          inputTokens: 1_000,
          cacheReadTokens: 9_000,
          cacheWriteTokens: 500,
          totalTokens: 10_520,
          costUsd: undefined,
        },
      ]);
    }

    const clineAdapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
    });
    const clineEvents = await collect(clineAdapter.read(uiMessagesPath));

    expect(clineEvents.map((event) => event.inputTokens)).toEqual([10_500, 1_000]);
  });

  it.runIf(canCountOpenFds)('closes both files when the consumer stops early', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cline-early-return-'));
    tempDirs.push(tempDir);
    const uiMessagesPath = path.join(tempDir, 'task-early-return', 'ui_messages.json');
    await mkdir(path.dirname(uiMessagesPath), { recursive: true });
    await writeFile(
      getClineTaskHistoryPath(uiMessagesPath),
      `${'x'.repeat(2 * 1024 * 1024)}<environment_details><model>m</model></environment_details>`,
      'utf8',
    );
    const entryCount = 2000;
    await writeFile(
      uiMessagesPath,
      JSON.stringify(
        Array.from({ length: entryCount }, (_, index) => ({
          type: 'say',
          say: 'api_req_started',
          ts: 1_772_445_600_000 + index,
          text: JSON.stringify({ tokensIn: 10, tokensOut: 5 }),
          padding: 'x'.repeat(1000),
        })),
      ),
      'utf8',
    );
    const adapter = createClineFamilyAdapter({
      id: 'cline',
      extensionId: CLINE_EXTENSION_IDS.cline,
    });
    const before = countOpenFds();

    for await (const event of adapter.read(uiMessagesPath)) {
      expect(event.model).toBe('m');
      break;
    }

    await waitForOpenFdCount(before);
    await expect(collect(adapter.read(uiMessagesPath))).resolves.toHaveLength(entryCount);
  });
});
