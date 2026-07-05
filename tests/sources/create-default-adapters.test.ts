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
    tempDirs.push(
      piTempDir,
      codexTempDir,
      geminiTempDir,
      droidTempDir,
      claudeTempDir,
      copilotTempDir,
      openclawTempDir,
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

    await writeFile(piFile, '{}\n', 'utf8');
    await writeFile(codexFile, '{}\n', 'utf8');
    await writeFile(geminiFile, '{}', 'utf8');
    await writeFile(droidFile, '{}', 'utf8');
    await writeFile(claudeFile, '{}\n', 'utf8');
    await writeFile(copilotFile, '{}\n', 'utf8');
    await writeFile(openclawFile, '{}\n', 'utf8');

    const adapters = createDefaultAdapters({
      sourceDir: [
        `pi=${piTempDir}`,
        `codex=${codexTempDir}`,
        `gemini=${geminiTempDir}`,
        `droid=${droidTempDir}`,
        `claude=${claudeTempDir}`,
        `copilot=${copilotTempDir}`,
        `openclaw=${openclawTempDir}`,
      ],
    });

    await expect(adapters[0].discoverFiles()).resolves.toEqual([await realpath(piFile)]);
    await expect(adapters[1].discoverFiles()).resolves.toEqual([await realpath(codexFile)]);
    await expect(adapters[2].discoverFiles()).resolves.toEqual([await realpath(geminiFile)]);
    await expect(adapters[3].discoverFiles()).resolves.toEqual([await realpath(droidFile)]);
    await expect(adapters[5].discoverFiles()).resolves.toEqual([await realpath(openclawFile)]);
    await expect(adapters[6].discoverFiles()).resolves.toEqual([await realpath(claudeFile)]);
    await expect(adapters[7].discoverFiles()).resolves.toEqual([await realpath(copilotFile)]);
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
});
