import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeSourceAdapter } from '../../src/sources/claude/claude-source-adapter.js';
import {
  createDefaultAdapters,
  getSourceOverrideOptions,
} from '../../src/sources/create-default-adapters.js';
import { MultiDirectorySourceAdapter } from '../../src/sources/multi-directory-source-adapter.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('createDefaultAdapters', () => {
  it('builds default adapters in stable order', () => {
    const adapters = createDefaultAdapters({});

    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'pi',
      'codex',
      'gemini',
      'droid',
      'opencode',
      'openclaw',
      'claude',
      'copilot',
      'goose',
      'amp',
      'qwen',
      'kimi',
      'cline',
      'roocode',
      'kilocode',
      'antigravity',
      'dsh',
    ]);
  });

  it('exposes source capabilities for provider pruning', () => {
    const adapters = createDefaultAdapters({});

    expect(adapters.find((adapter) => adapter.id === 'codex')?.capabilities).toEqual({
      fixedProviderRoots: ['openai'],
      eventsPrecedeFileMtime: true,
    });
    expect(adapters.find((adapter) => adapter.id === 'gemini')?.capabilities).toEqual({
      fixedProviderRoots: ['google'],
      eventsPrecedeFileMtime: true,
    });
  });

  it('lets only file-per-session sources skip files by mtime', () => {
    const adapters = createDefaultAdapters({});
    const skippable = adapters
      .filter((adapter) => adapter.capabilities?.eventsPrecedeFileMtime)
      .map((adapter) => adapter.id);
    const notSkippable = adapters
      .filter((adapter) => !adapter.capabilities?.eventsPrecedeFileMtime)
      .map((adapter) => adapter.id);

    // SQLite sources keep events in a database whose mtime does not track each row.
    expect(notSkippable.sort()).toEqual(['antigravity', 'goose', 'opencode']);
    expect(skippable.length + notSkippable.length).toBe(adapters.length);
  });

  it('supports generic source directory overrides', async () => {
    const piTempDir = await mkdtemp(path.join(canonicalTmpdir(), 'usage-adapters-pi-source-dir-'));
    const codexTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-codex-source-dir-'),
    );
    const geminiTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-gemini-source-dir-'),
    );
    const droidTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-droid-source-dir-'),
    );
    const claudeTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-claude-source-dir-'),
    );
    const copilotTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-copilot-source-dir-'),
    );
    const openclawTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-openclaw-source-dir-'),
    );
    const ampTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-amp-source-dir-'),
    );
    const qwenTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-qwen-source-dir-'),
    );
    const kimiTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-kimi-source-dir-'),
    );
    const clineTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-cline-source-dir-'),
    );
    const roocodeTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-roocode-source-dir-'),
    );
    const kilocodeTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-kilocode-source-dir-'),
    );
    const antigravityTempDir = await mkdtemp(
      path.join(canonicalTmpdir(), 'usage-adapters-antigravity-source-dir-'),
    );
    tempDirs.push(
      piTempDir,
      codexTempDir,
      geminiTempDir,
      droidTempDir,
      claudeTempDir,
      copilotTempDir,
      openclawTempDir,
      ampTempDir,
      qwenTempDir,
      kimiTempDir,
      clineTempDir,
      roocodeTempDir,
      kilocodeTempDir,
      antigravityTempDir,
    );

    const piFile = path.join(piTempDir, 'pi-session.jsonl');
    const codexFile = path.join(codexTempDir, 'codex-session.jsonl');
    const geminiChatsDir = path.join(geminiTempDir, 'tmp', 'test-project', 'chats');
    await mkdir(geminiChatsDir, { recursive: true });
    const geminiFile = path.join(geminiChatsDir, 'session.json');
    const droidFile = path.join(droidTempDir, 'droid-session.settings.json');
    const claudeFile = path.join(claudeTempDir, 'claude-session.jsonl');
    const copilotFile = path.join(copilotTempDir, 'copilot-session.jsonl');
    const openclawFile = path.join(openclawTempDir, 'openclaw-session.jsonl');
    const ampFile = path.join(ampTempDir, 'amp-thread.json');
    const qwenFile = path.join(qwenTempDir, 'demo', 'chats', 'qwen-session.jsonl');
    const kimiFile = path.join(kimiTempDir, 'group-a', 'session-a', 'wire.jsonl');
    const clineFile = path.join(clineTempDir, 'task-a', 'ui_messages.json');
    const roocodeFile = path.join(roocodeTempDir, 'task-a', 'ui_messages.json');
    const kilocodeFile = path.join(kilocodeTempDir, 'task-a', 'ui_messages.json');
    const antigravityFile = path.join(antigravityTempDir, 'conversation.db');
    await mkdir(path.dirname(qwenFile), { recursive: true });
    await mkdir(path.dirname(kimiFile), { recursive: true });
    await mkdir(path.dirname(clineFile), { recursive: true });
    await mkdir(path.dirname(roocodeFile), { recursive: true });
    await mkdir(path.dirname(kilocodeFile), { recursive: true });

    await writeFile(piFile, '{}\n', 'utf8');
    await writeFile(codexFile, '{}\n', 'utf8');
    await writeFile(geminiFile, '{}', 'utf8');
    await writeFile(droidFile, '{}', 'utf8');
    await writeFile(claudeFile, '{}\n', 'utf8');
    await writeFile(copilotFile, '{}\n', 'utf8');
    await writeFile(openclawFile, '{}\n', 'utf8');
    await writeFile(ampFile, '{}', 'utf8');
    await writeFile(qwenFile, '{}\n', 'utf8');
    await writeFile(kimiFile, '{}\n', 'utf8');
    await writeFile(clineFile, '[]', 'utf8');
    await writeFile(roocodeFile, '[]', 'utf8');
    await writeFile(kilocodeFile, '[]', 'utf8');
    await writeFile(antigravityFile, '', 'utf8');

    const adapters = createDefaultAdapters({
      sourceDir: [
        `pi=${piTempDir}`,
        `codex=${codexTempDir}`,
        `gemini=${geminiTempDir}`,
        `droid=${droidTempDir}`,
        `claude=${claudeTempDir}`,
        `copilot=${copilotTempDir}`,
        `openclaw=${openclawTempDir}`,
        `amp=${ampTempDir}`,
        `qwen=${qwenTempDir}`,
        `kimi=${kimiTempDir}`,
        `cline=${clineTempDir}`,
        `roocode=${roocodeTempDir}`,
        `kilocode=${kilocodeTempDir}`,
        `antigravity=${antigravityTempDir}`,
      ],
    });

    await expect(adapters[0].discoverFiles()).resolves.toEqual([await realpath(piFile)]);
    await expect(adapters[1].discoverFiles()).resolves.toEqual([await realpath(codexFile)]);
    await expect(adapters[2].discoverFiles()).resolves.toEqual([await realpath(geminiFile)]);
    await expect(adapters[3].discoverFiles()).resolves.toEqual([await realpath(droidFile)]);
    await expect(adapters[5].discoverFiles()).resolves.toEqual([await realpath(openclawFile)]);
    await expect(adapters[6].discoverFiles()).resolves.toEqual([await realpath(claudeFile)]);
    await expect(adapters[7].discoverFiles()).resolves.toEqual([await realpath(copilotFile)]);
    await expect(adapters[9].discoverFiles()).resolves.toEqual([await realpath(ampFile)]);
    await expect(adapters[10].discoverFiles()).resolves.toEqual([await realpath(qwenFile)]);
    await expect(adapters[11].discoverFiles()).resolves.toEqual([await realpath(kimiFile)]);
    await expect(adapters[12].discoverFiles()).resolves.toEqual([await realpath(clineFile)]);
    await expect(adapters[13].discoverFiles()).resolves.toEqual([await realpath(roocodeFile)]);
    await expect(adapters[14].discoverFiles()).resolves.toEqual([await realpath(kilocodeFile)]);
    await expect(adapters[15].discoverFiles()).resolves.toEqual([await realpath(antigravityFile)]);
  });

  it('throws on invalid source directory override entries', () => {
    expect(() => createDefaultAdapters({ sourceDir: ['invalid'] })).toThrow(
      '--source-dir must use format <source-id>=<path>',
    );
  });

  it('scans every directory given for one source and parses each file once', async () => {
    const extraDir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-extra-'));
    tempDirs.push(extraDir);
    const fixturesDir = path.resolve('tests/fixtures/codex');
    const copiedFile = path.join(extraDir, 'copied.jsonl');
    await writeFile(
      copiedFile,
      await readFile(path.join(fixturesDir, 'session-token-count.jsonl'), 'utf8'),
    );

    const adapters = createDefaultAdapters({
      sourceDir: [`codex=${fixturesDir}`, `codex=${extraDir}`, `codex=${fixturesDir}`],
    });
    const codex = adapters.find((adapter) => adapter.id === 'codex');
    const files = (await codex?.discoverFiles()) ?? [];

    expect(adapters.filter((adapter) => adapter.id === 'codex')).toHaveLength(1);
    expect(codex).toBeInstanceOf(MultiDirectorySourceAdapter);
    expect(files.filter((file) => file.startsWith(fixturesDir))).toHaveLength(3);
    expect(files).toContain(copiedFile);
    expect((await codex?.parseFile(copiedFile))?.length).toBeGreaterThan(0);
  });

  it('prefers repeated dedicated directory flags over --source-dir', async () => {
    const fixturesDir = path.resolve('tests/fixtures/pi');
    const adapters = createDefaultAdapters({
      piDir: [fixturesDir, fixturesDir],
      sourceDir: ['pi=/tmp/ignored'],
    });
    const pi = adapters.find((adapter) => adapter.id === 'pi');

    expect(pi).not.toBeInstanceOf(MultiDirectorySourceAdapter);
    await expect(pi?.discoverFiles()).resolves.toEqual([
      path.join(fixturesDir, 'session-mixed.jsonl'),
    ]);
  });

  it('gives Claude every directory in one adapter so fork deduplication sees all roots', async () => {
    // An empty directory of its own: the system temp dir can hold anything, and scanning
    // it is slow.
    const existingDir = await mkdtemp(path.join(canonicalTmpdir(), 'llm-usage-claude-root-'));
    const missingDir = path.join(existingDir, 'missing');
    const claude = createDefaultAdapters({ claudeDir: [existingDir, missingDir] }).find(
      (adapter) => adapter.id === 'claude',
    );

    try {
      expect(claude).toBeInstanceOf(ClaudeSourceAdapter);
      await expect(claude?.discoverFiles()).rejects.toThrow(
        `Claude projects directory is missing or unreadable: ${missingDir}`,
      );
    } finally {
      await rm(existingDir, { recursive: true, force: true });
    }
  });

  it('rejects several paths for a database source', () => {
    expect(() =>
      createDefaultAdapters({ opencodeDb: ['/tmp/a.db', '/tmp/b.db'] as never }),
    ).toThrow('--opencode-db takes a single path');
    expect(() => createDefaultAdapters({ claudeDir: ['/tmp/a', ' '] })).toThrow(
      '--claude-dir must be a non-empty path',
    );
  });

  it('throws on unknown source ids in source directory overrides', () => {
    expect(() => createDefaultAdapters({ sourceDir: ['opencode=/tmp/opencode'] })).toThrow(
      '--source-dir does not support "opencode". Use --opencode-db instead.',
    );
    expect(() => createDefaultAdapters({ sourceDir: ['goose=/tmp/goose'] })).toThrow(
      '--source-dir does not support "goose". Use --goose-db instead.',
    );
  });

  it('wires --opencode-db into the OpenCode adapter discovery path', async () => {
    const tempDir = await mkdtemp(path.join(canonicalTmpdir(), 'usage-adapters-opencode-db-'));
    tempDirs.push(tempDir);
    const opencodeDbPath = path.join(tempDir, 'opencode.db');
    await writeFile(opencodeDbPath, '', 'utf8');

    const adapters = createDefaultAdapters({ opencodeDb: opencodeDbPath });
    const opencodeAdapter = adapters.find((adapter) => adapter.id === 'opencode');

    await expect(opencodeAdapter?.discoverFiles()).resolves.toEqual([opencodeDbPath]);
  });

  it('wires --goose-db into the Goose adapter discovery path', async () => {
    const tempDir = await mkdtemp(path.join(canonicalTmpdir(), 'usage-adapters-goose-db-'));
    tempDirs.push(tempDir);
    const gooseDbPath = path.join(tempDir, 'sessions.db');
    await writeFile(gooseDbPath, '', 'utf8');

    const adapters = createDefaultAdapters({ gooseDb: gooseDbPath });
    const gooseAdapter = adapters.find((adapter) => adapter.id === 'goose');

    await expect(gooseAdapter?.discoverFiles()).resolves.toEqual([gooseDbPath]);
  });

  it.each(getSourceOverrideOptions().map((option) => [option.flag.split(' ')[0], option] as const))(
    'throws when %s is blank',
    (flag, option) => {
      expect(() => createDefaultAdapters({ [option.optionKey]: '   ' })).toThrow(
        `${flag} must be a non-empty path`,
      );
    },
  );

  // One session file each, at the place discovery looks for it.
  const sessionFileLayouts = [
    { source: 'openclaw', optionKey: 'openclawDir', file: ['session.jsonl'], content: '{}\n' },
    { source: 'copilot', optionKey: 'copilotDir', file: ['session.jsonl'], content: '{}\n' },
    { source: 'amp', optionKey: 'ampDir', file: ['thread.json'], content: '{}' },
    {
      source: 'qwen',
      optionKey: 'qwenDir',
      file: ['demo', 'chats', 'session.jsonl'],
      content: '{}\n',
    },
    {
      source: 'kimi',
      optionKey: 'kimiDir',
      file: ['group-a', 'session-a', 'wire.jsonl'],
      content: '{}\n',
    },
    { source: 'cline', optionKey: 'clineDir', file: ['task-a', 'ui_messages.json'], content: '[]' },
    {
      source: 'roocode',
      optionKey: 'roocodeDir',
      file: ['task-a', 'ui_messages.json'],
      content: '[]',
    },
    {
      source: 'kilocode',
      optionKey: 'kilocodeDir',
      file: ['task-a', 'ui_messages.json'],
      content: '[]',
    },
    { source: 'antigravity', optionKey: 'antigravityDir', file: ['conversation.db'], content: '' },
  ] as const;

  async function writeSessionFile(layout: (typeof sessionFileLayouts)[number]): Promise<string> {
    const directory = await mkdtemp(
      path.join(canonicalTmpdir(), `usage-adapters-${layout.source}-`),
    );
    tempDirs.push(directory);
    const filePath = path.join(directory, ...layout.file);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, layout.content, 'utf8');
    return directory;
  }

  it.each(sessionFileLayouts)('wires the $source directory flag into discovery', async (layout) => {
    const directory = await writeSessionFile(layout);
    const adapter = createDefaultAdapters({ [layout.optionKey]: directory }).find(
      (candidate) => candidate.id === layout.source,
    );

    await expect(adapter?.discoverFiles()).resolves.toEqual([
      await realpath(path.join(directory, ...layout.file)),
    ]);
  });

  it.each(sessionFileLayouts)(
    'prefers the $source directory flag over --source-dir',
    async (layout) => {
      const explicitDirectory = await writeSessionFile(layout);
      const sourceDirDirectory = await writeSessionFile(layout);
      const adapter = createDefaultAdapters({
        [layout.optionKey]: explicitDirectory,
        sourceDir: [`${layout.source}=${sourceDirDirectory}`],
      }).find((candidate) => candidate.id === layout.source);

      await expect(adapter?.discoverFiles()).resolves.toEqual([
        await realpath(path.join(explicitDirectory, ...layout.file)),
      ]);
    },
  );

  it.each([
    ['gemini', 'geminiDir', 'Gemini directory'],
    ['droid', 'droidDir', 'Droid sessions directory'],
    ['pi', 'piDir', 'PI sessions directory'],
    ['codex', 'codexDir', 'Codex sessions directory'],
    ['copilot', 'copilotDir', 'Copilot OTEL directory'],
    ['claude', 'claudeDir', 'Claude projects directory'],
    ['openclaw', 'openclawDir', 'OpenClaw agents directory'],
    ['amp', 'ampDir', 'Amp threads directory'],
    ['qwen', 'qwenDir', 'Qwen projects directory'],
    ['kimi', 'kimiDir', 'Kimi sessions directory'],
    ['cline', 'clineDir', 'cline tasks directory'],
    ['roocode', 'roocodeDir', 'roocode tasks directory'],
    ['kilocode', 'kilocodeDir', 'kilocode tasks directory'],
    ['antigravity', 'antigravityDir', 'Antigravity conversations directory'],
  ])(
    'fails %s discovery when its configured directory is missing',
    async (source, optionKey, label) => {
      const adapter = createDefaultAdapters({
        [optionKey]: path.join(canonicalTmpdir(), `missing-${source}-${Date.now()}`),
      }).find((candidate) => candidate.id === source);

      await expect(adapter?.discoverFiles()).rejects.toThrow(`${label} is missing or unreadable`);
    },
  );

  it.each([
    ['gemini', 'geminiDir', 'Gemini directory'],
    ['droid', 'droidDir', 'Droid sessions directory'],
    ['pi', 'piDir', 'PI sessions directory'],
    ['codex', 'codexDir', 'Codex sessions directory'],
  ])('fails %s discovery when its configured path is a file', async (source, optionKey, label) => {
    const directory = await mkdtemp(path.join(canonicalTmpdir(), `usage-adapters-${source}-file-`));
    tempDirs.push(directory);
    const filePath = path.join(directory, 'not-a-directory');
    await writeFile(filePath, '{}', 'utf8');
    const adapter = createDefaultAdapters({ [optionKey]: filePath }).find(
      (candidate) => candidate.id === source,
    );

    await expect(adapter?.discoverFiles()).rejects.toThrow(
      `${label} is not a directory: ${filePath}`,
    );
  });
});
