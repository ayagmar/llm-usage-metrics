import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultAdapters } from '../../src/sources/create-default-adapters.js';

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
    ]);
  });

  it('exposes source capabilities for provider pruning', () => {
    const adapters = createDefaultAdapters({});

    expect(adapters.find((adapter) => adapter.id === 'codex')?.capabilities).toEqual({
      fixedProviderRoots: ['openai'],
    });
    expect(adapters.find((adapter) => adapter.id === 'gemini')?.capabilities).toEqual({
      fixedProviderRoots: ['google'],
    });
  });

  it('supports generic source directory overrides', async () => {
    const piTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-pi-source-dir-'));
    const codexTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-codex-source-dir-'));
    const geminiTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-gemini-source-dir-'),
    );
    const droidTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-droid-source-dir-'));
    const claudeTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-claude-source-dir-'),
    );
    const copilotTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-copilot-source-dir-'),
    );
    const openclawTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-openclaw-source-dir-'),
    );
    const ampTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-amp-source-dir-'));
    const qwenTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-qwen-source-dir-'));
    const kimiTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-kimi-source-dir-'));
    const clineTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-cline-source-dir-'));
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
    await mkdir(path.dirname(qwenFile), { recursive: true });
    await mkdir(path.dirname(kimiFile), { recursive: true });
    await mkdir(path.dirname(clineFile), { recursive: true });

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
  });

  it('throws on invalid source directory override entries', () => {
    expect(() => createDefaultAdapters({ sourceDir: ['invalid'] })).toThrow(
      '--source-dir must use format <source-id>=<path>',
    );
  });

  it('throws on duplicate source ids in source directory overrides', () => {
    expect(() => createDefaultAdapters({ sourceDir: ['pi=/tmp/a', 'pi=/tmp/b'] })).toThrow(
      'Duplicate --source-dir source id: pi',
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
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-opencode-db-'));
    tempDirs.push(tempDir);
    const opencodeDbPath = path.join(tempDir, 'opencode.db');
    await writeFile(opencodeDbPath, '', 'utf8');

    const adapters = createDefaultAdapters({ opencodeDb: opencodeDbPath });
    const opencodeAdapter = adapters.find((adapter) => adapter.id === 'opencode');

    await expect(opencodeAdapter?.discoverFiles()).resolves.toEqual([opencodeDbPath]);
  });

  it('throws when --opencode-db is blank', () => {
    expect(() => createDefaultAdapters({ opencodeDb: '   ' })).toThrow(
      '--opencode-db must be a non-empty path',
    );
  });

  it('wires --goose-db into the Goose adapter discovery path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-goose-db-'));
    tempDirs.push(tempDir);
    const gooseDbPath = path.join(tempDir, 'sessions.db');
    await writeFile(gooseDbPath, '', 'utf8');

    const adapters = createDefaultAdapters({ gooseDb: gooseDbPath });
    const gooseAdapter = adapters.find((adapter) => adapter.id === 'goose');

    await expect(gooseAdapter?.discoverFiles()).resolves.toEqual([gooseDbPath]);
  });

  it('throws when --goose-db is blank', () => {
    expect(() => createDefaultAdapters({ gooseDb: '   ' })).toThrow(
      '--goose-db must be a non-empty path',
    );
  });

  it('throws when --pi-dir is blank', () => {
    expect(() => createDefaultAdapters({ piDir: '   ' })).toThrow(
      '--pi-dir must be a non-empty path',
    );
  });

  it('throws when --codex-dir is blank', () => {
    expect(() => createDefaultAdapters({ codexDir: '   ' })).toThrow(
      '--codex-dir must be a non-empty path',
    );
  });

  it('throws when --copilot-dir is blank', () => {
    expect(() => createDefaultAdapters({ copilotDir: '   ' })).toThrow(
      '--copilot-dir must be a non-empty path',
    );
  });

  it('throws when --gemini-dir is blank', () => {
    expect(() => createDefaultAdapters({ geminiDir: '   ' })).toThrow(
      '--gemini-dir must be a non-empty path',
    );
  });

  it('throws when --droid-dir is blank', () => {
    expect(() => createDefaultAdapters({ droidDir: '   ' })).toThrow(
      '--droid-dir must be a non-empty path',
    );
  });

  it('throws when --claude-dir is blank', () => {
    expect(() => createDefaultAdapters({ claudeDir: '   ' })).toThrow(
      '--claude-dir must be a non-empty path',
    );
  });

  it('throws when --openclaw-dir is blank', () => {
    expect(() => createDefaultAdapters({ openclawDir: '   ' })).toThrow(
      '--openclaw-dir must be a non-empty path',
    );
  });

  it('throws when --amp-dir is blank', () => {
    expect(() => createDefaultAdapters({ ampDir: '   ' })).toThrow(
      '--amp-dir must be a non-empty path',
    );
  });

  it('throws when --qwen-dir is blank', () => {
    expect(() => createDefaultAdapters({ qwenDir: '   ' })).toThrow(
      '--qwen-dir must be a non-empty path',
    );
  });

  it('throws when --kimi-dir is blank', () => {
    expect(() => createDefaultAdapters({ kimiDir: '   ' })).toThrow(
      '--kimi-dir must be a non-empty path',
    );
  });

  it('throws when --cline-dir is blank', () => {
    expect(() => createDefaultAdapters({ clineDir: '   ' })).toThrow(
      '--cline-dir must be a non-empty path',
    );
  });

  it('wires --openclaw-dir into the OpenClaw adapter discovery path', async () => {
    const openclawTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-openclaw-dir-'));
    tempDirs.push(openclawTempDir);
    const openclawFile = path.join(openclawTempDir, 'openclaw-session.jsonl');
    await writeFile(openclawFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({ openclawDir: openclawTempDir });
    const openclawAdapter = adapters.find((adapter) => adapter.id === 'openclaw');

    await expect(openclawAdapter?.discoverFiles()).resolves.toEqual([await realpath(openclawFile)]);
  });

  it('prefers --openclaw-dir over generic openclaw source directory overrides', async () => {
    const explicitTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-openclaw-explicit-dir-'),
    );
    const sourceDirTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-openclaw-source-dir-precedence-'),
    );
    tempDirs.push(explicitTempDir, sourceDirTempDir);
    const explicitFile = path.join(explicitTempDir, 'explicit-openclaw-session.jsonl');
    const sourceDirFile = path.join(sourceDirTempDir, 'source-dir-openclaw-session.jsonl');
    await writeFile(explicitFile, '{}\n', 'utf8');
    await writeFile(sourceDirFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      openclawDir: explicitTempDir,
      sourceDir: [`openclaw=${sourceDirTempDir}`],
    });
    const openclawAdapter = adapters.find((adapter) => adapter.id === 'openclaw');

    await expect(openclawAdapter?.discoverFiles()).resolves.toEqual([await realpath(explicitFile)]);
  });

  it('wires --copilot-dir into the Copilot adapter discovery path', async () => {
    const copilotTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-copilot-dir-'));
    tempDirs.push(copilotTempDir);
    const copilotFile = path.join(copilotTempDir, 'copilot-session.jsonl');
    await writeFile(copilotFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({ copilotDir: copilotTempDir });
    const copilotAdapter = adapters.find((adapter) => adapter.id === 'copilot');

    await expect(copilotAdapter?.discoverFiles()).resolves.toEqual([await realpath(copilotFile)]);
  });

  it('prefers --copilot-dir over generic copilot source directory overrides', async () => {
    const explicitTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-copilot-explicit-dir-'),
    );
    const sourceDirTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-copilot-source-dir-precedence-'),
    );
    tempDirs.push(explicitTempDir, sourceDirTempDir);
    const explicitFile = path.join(explicitTempDir, 'explicit-copilot-session.jsonl');
    const sourceDirFile = path.join(sourceDirTempDir, 'source-dir-copilot-session.jsonl');
    await writeFile(explicitFile, '{}\n', 'utf8');
    await writeFile(sourceDirFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      copilotDir: explicitTempDir,
      sourceDir: [`copilot=${sourceDirTempDir}`],
    });
    const copilotAdapter = adapters.find((adapter) => adapter.id === 'copilot');

    await expect(copilotAdapter?.discoverFiles()).resolves.toEqual([await realpath(explicitFile)]);
  });

  it('wires --amp-dir into the Amp adapter discovery path', async () => {
    const ampTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-amp-dir-'));
    tempDirs.push(ampTempDir);
    const ampFile = path.join(ampTempDir, 'amp-thread.json');
    await writeFile(ampFile, '{}', 'utf8');

    const adapters = createDefaultAdapters({ ampDir: ampTempDir });
    const ampAdapter = adapters.find((adapter) => adapter.id === 'amp');

    await expect(ampAdapter?.discoverFiles()).resolves.toEqual([await realpath(ampFile)]);
  });

  it('prefers --amp-dir over generic amp source directory overrides', async () => {
    const explicitTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-amp-explicit-dir-'),
    );
    const sourceDirTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-amp-source-dir-precedence-'),
    );
    tempDirs.push(explicitTempDir, sourceDirTempDir);
    const explicitFile = path.join(explicitTempDir, 'explicit-amp-thread.json');
    const sourceDirFile = path.join(sourceDirTempDir, 'source-dir-amp-thread.json');
    await writeFile(explicitFile, '{}', 'utf8');
    await writeFile(sourceDirFile, '{}', 'utf8');

    const adapters = createDefaultAdapters({
      ampDir: explicitTempDir,
      sourceDir: [`amp=${sourceDirTempDir}`],
    });
    const ampAdapter = adapters.find((adapter) => adapter.id === 'amp');

    await expect(ampAdapter?.discoverFiles()).resolves.toEqual([await realpath(explicitFile)]);
  });

  it('wires --qwen-dir into the Qwen adapter discovery path', async () => {
    const qwenTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-qwen-dir-'));
    tempDirs.push(qwenTempDir);
    const qwenFile = path.join(qwenTempDir, 'demo', 'chats', 'qwen-session.jsonl');
    await mkdir(path.dirname(qwenFile), { recursive: true });
    await writeFile(qwenFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({ qwenDir: qwenTempDir });
    const qwenAdapter = adapters.find((adapter) => adapter.id === 'qwen');

    await expect(qwenAdapter?.discoverFiles()).resolves.toEqual([await realpath(qwenFile)]);
  });

  it('prefers --qwen-dir over generic qwen source directory overrides', async () => {
    const explicitTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-qwen-explicit-dir-'),
    );
    const sourceDirTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-qwen-source-dir-precedence-'),
    );
    tempDirs.push(explicitTempDir, sourceDirTempDir);
    const explicitFile = path.join(explicitTempDir, 'demo', 'chats', 'explicit-qwen-session.jsonl');
    const sourceDirFile = path.join(
      sourceDirTempDir,
      'demo',
      'chats',
      'source-dir-qwen-session.jsonl',
    );
    await mkdir(path.dirname(explicitFile), { recursive: true });
    await mkdir(path.dirname(sourceDirFile), { recursive: true });
    await writeFile(explicitFile, '{}\n', 'utf8');
    await writeFile(sourceDirFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      qwenDir: explicitTempDir,
      sourceDir: [`qwen=${sourceDirTempDir}`],
    });
    const qwenAdapter = adapters.find((adapter) => adapter.id === 'qwen');

    await expect(qwenAdapter?.discoverFiles()).resolves.toEqual([await realpath(explicitFile)]);
  });

  it('wires --kimi-dir into the Kimi adapter discovery path', async () => {
    const kimiTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-kimi-dir-'));
    tempDirs.push(kimiTempDir);
    const kimiFile = path.join(kimiTempDir, 'group-a', 'session-a', 'wire.jsonl');
    await mkdir(path.dirname(kimiFile), { recursive: true });
    await writeFile(kimiFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({ kimiDir: kimiTempDir });
    const kimiAdapter = adapters.find((adapter) => adapter.id === 'kimi');

    await expect(kimiAdapter?.discoverFiles()).resolves.toEqual([await realpath(kimiFile)]);
  });

  it('prefers --kimi-dir over generic kimi source directory overrides', async () => {
    const explicitTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-kimi-explicit-dir-'),
    );
    const sourceDirTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-kimi-source-dir-precedence-'),
    );
    tempDirs.push(explicitTempDir, sourceDirTempDir);
    const explicitFile = path.join(explicitTempDir, 'group-a', 'session-a', 'wire.jsonl');
    const sourceDirFile = path.join(sourceDirTempDir, 'group-b', 'session-b', 'wire.jsonl');
    await mkdir(path.dirname(explicitFile), { recursive: true });
    await mkdir(path.dirname(sourceDirFile), { recursive: true });
    await writeFile(explicitFile, '{}\n', 'utf8');
    await writeFile(sourceDirFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      kimiDir: explicitTempDir,
      sourceDir: [`kimi=${sourceDirTempDir}`],
    });
    const kimiAdapter = adapters.find((adapter) => adapter.id === 'kimi');

    await expect(kimiAdapter?.discoverFiles()).resolves.toEqual([await realpath(explicitFile)]);
  });

  it('wires --cline-dir into the Cline adapter discovery path', async () => {
    const clineTempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-cline-dir-'));
    tempDirs.push(clineTempDir);
    const clineFile = path.join(clineTempDir, 'task-a', 'ui_messages.json');
    await mkdir(path.dirname(clineFile), { recursive: true });
    await writeFile(clineFile, '[]', 'utf8');

    const adapters = createDefaultAdapters({ clineDir: clineTempDir });
    const clineAdapter = adapters.find((adapter) => adapter.id === 'cline');

    await expect(clineAdapter?.discoverFiles()).resolves.toEqual([await realpath(clineFile)]);
  });

  it('prefers --cline-dir over generic cline source directory overrides', async () => {
    const explicitTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-cline-explicit-dir-'),
    );
    const sourceDirTempDir = await mkdtemp(
      path.join(os.tmpdir(), 'usage-adapters-cline-source-dir-precedence-'),
    );
    tempDirs.push(explicitTempDir, sourceDirTempDir);
    const explicitFile = path.join(explicitTempDir, 'task-a', 'ui_messages.json');
    const sourceDirFile = path.join(sourceDirTempDir, 'task-b', 'ui_messages.json');
    await mkdir(path.dirname(explicitFile), { recursive: true });
    await mkdir(path.dirname(sourceDirFile), { recursive: true });
    await writeFile(explicitFile, '[]', 'utf8');
    await writeFile(sourceDirFile, '[]', 'utf8');

    const adapters = createDefaultAdapters({
      clineDir: explicitTempDir,
      sourceDir: [`cline=${sourceDirTempDir}`],
    });
    const clineAdapter = adapters.find((adapter) => adapter.id === 'cline');

    await expect(clineAdapter?.discoverFiles()).resolves.toEqual([await realpath(explicitFile)]);
  });

  it('fails gemini discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      geminiDir: path.join(os.tmpdir(), `missing-gemini-${Date.now()}`),
    });
    const geminiAdapter = adapters.find((adapter) => adapter.id === 'gemini');

    await expect(geminiAdapter?.discoverFiles()).rejects.toThrow(
      'Gemini directory is missing or unreadable',
    );
  });

  it('fails gemini discovery when an explicitly configured path is a file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-gemini-file-path-'));
    tempDirs.push(tempDir);
    const geminiFilePath = path.join(tempDir, 'gemini.json');
    await writeFile(geminiFilePath, '{}', 'utf8');

    const adapters = createDefaultAdapters({
      geminiDir: geminiFilePath,
    });
    const geminiAdapter = adapters.find((adapter) => adapter.id === 'gemini');

    await expect(geminiAdapter?.discoverFiles()).rejects.toThrow(
      `Gemini directory is not a directory: ${geminiFilePath}`,
    );
  });

  it('fails droid discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      droidDir: path.join(os.tmpdir(), `missing-droid-${Date.now()}`),
    });
    const droidAdapter = adapters.find((adapter) => adapter.id === 'droid');

    await expect(droidAdapter?.discoverFiles()).rejects.toThrow(
      'Droid sessions directory is missing or unreadable',
    );
  });

  it('fails droid discovery when an explicitly configured path is a file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-droid-file-path-'));
    tempDirs.push(tempDir);
    const droidFilePath = path.join(tempDir, 'droid.settings.json');
    await writeFile(droidFilePath, '{}', 'utf8');

    const adapters = createDefaultAdapters({
      droidDir: droidFilePath,
    });
    const droidAdapter = adapters.find((adapter) => adapter.id === 'droid');

    await expect(droidAdapter?.discoverFiles()).rejects.toThrow(
      `Droid sessions directory is not a directory: ${droidFilePath}`,
    );
  });

  it('fails pi discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      piDir: path.join(os.tmpdir(), `missing-pi-${Date.now()}`),
    });
    const piAdapter = adapters.find((adapter) => adapter.id === 'pi');

    await expect(piAdapter?.discoverFiles()).rejects.toThrow(
      'PI sessions directory is missing or unreadable',
    );
  });

  it('fails pi discovery when an explicitly configured path is a file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-pi-file-path-'));
    tempDirs.push(tempDir);
    const piFilePath = path.join(tempDir, 'pi.jsonl');
    await writeFile(piFilePath, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      piDir: piFilePath,
    });
    const piAdapter = adapters.find((adapter) => adapter.id === 'pi');

    await expect(piAdapter?.discoverFiles()).rejects.toThrow(
      `PI sessions directory is not a directory: ${piFilePath}`,
    );
  });

  it('fails codex discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      codexDir: path.join(os.tmpdir(), `missing-codex-${Date.now()}`),
    });
    const codexAdapter = adapters.find((adapter) => adapter.id === 'codex');

    await expect(codexAdapter?.discoverFiles()).rejects.toThrow(
      'Codex sessions directory is missing or unreadable',
    );
  });

  it('fails codex discovery when an explicitly configured path is a file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'usage-adapters-codex-file-path-'));
    tempDirs.push(tempDir);
    const codexFilePath = path.join(tempDir, 'codex.jsonl');
    await writeFile(codexFilePath, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      codexDir: codexFilePath,
    });
    const codexAdapter = adapters.find((adapter) => adapter.id === 'codex');

    await expect(codexAdapter?.discoverFiles()).rejects.toThrow(
      `Codex sessions directory is not a directory: ${codexFilePath}`,
    );
  });

  it('fails copilot discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      copilotDir: path.join(os.tmpdir(), `missing-copilot-${Date.now()}`),
    });
    const copilotAdapter = adapters.find((adapter) => adapter.id === 'copilot');

    await expect(copilotAdapter?.discoverFiles()).rejects.toThrow(
      'Copilot OTEL directory is missing or unreadable',
    );
  });

  it('fails claude discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      claudeDir: path.join(os.tmpdir(), `missing-claude-${Date.now()}`),
    });
    const claudeAdapter = adapters.find((adapter) => adapter.id === 'claude');

    await expect(claudeAdapter?.discoverFiles()).rejects.toThrow(
      'Claude projects directory is missing or unreadable',
    );
  });

  it('fails openclaw discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      openclawDir: path.join(os.tmpdir(), `missing-openclaw-${Date.now()}`),
    });
    const openclawAdapter = adapters.find((adapter) => adapter.id === 'openclaw');

    await expect(openclawAdapter?.discoverFiles()).rejects.toThrow(
      'OpenClaw agents directory is missing or unreadable',
    );
  });

  it('fails amp discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      ampDir: path.join(os.tmpdir(), `missing-amp-${Date.now()}`),
    });
    const ampAdapter = adapters.find((adapter) => adapter.id === 'amp');

    await expect(ampAdapter?.discoverFiles()).rejects.toThrow(
      'Amp threads directory is missing or unreadable',
    );
  });

  it('fails qwen discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      qwenDir: path.join(os.tmpdir(), `missing-qwen-${Date.now()}`),
    });
    const qwenAdapter = adapters.find((adapter) => adapter.id === 'qwen');

    await expect(qwenAdapter?.discoverFiles()).rejects.toThrow(
      'Qwen projects directory is missing or unreadable',
    );
  });

  it('fails kimi discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      kimiDir: path.join(os.tmpdir(), `missing-kimi-${Date.now()}`),
    });
    const kimiAdapter = adapters.find((adapter) => adapter.id === 'kimi');

    await expect(kimiAdapter?.discoverFiles()).rejects.toThrow(
      'Kimi sessions directory is missing or unreadable',
    );
  });

  it('fails cline discovery when an explicitly configured directory is missing', async () => {
    const adapters = createDefaultAdapters({
      clineDir: path.join(os.tmpdir(), `missing-cline-${Date.now()}`),
    });
    const clineAdapter = adapters.find((adapter) => adapter.id === 'cline');

    await expect(clineAdapter?.discoverFiles()).rejects.toThrow(
      'cline tasks directory is missing or unreadable',
    );
  });
});
