import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    ]);
  });

  it('exposes fixed-provider capabilities for codex and gemini', () => {
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
    tempDirs.push(piTempDir, codexTempDir, geminiTempDir, droidTempDir);

    const piFile = path.join(piTempDir, 'pi-session.jsonl');
    const codexFile = path.join(codexTempDir, 'codex-session.jsonl');
    const geminiChatsDir = path.join(geminiTempDir, 'tmp', 'test-project', 'chats');
    await mkdir(geminiChatsDir, { recursive: true });
    const geminiFile = path.join(geminiChatsDir, 'session.json');
    const droidFile = path.join(droidTempDir, 'droid-session.settings.json');

    await writeFile(piFile, '{}\n', 'utf8');
    await writeFile(codexFile, '{}\n', 'utf8');
    await writeFile(geminiFile, '{}', 'utf8');
    await writeFile(droidFile, '{}', 'utf8');

    const adapters = createDefaultAdapters({
      sourceDir: [
        `pi=${piTempDir}`,
        `codex=${codexTempDir}`,
        `gemini=${geminiTempDir}`,
        `droid=${droidTempDir}`,
      ],
    });

    await expect(adapters[0].discoverFiles()).resolves.toEqual([piFile]);
    await expect(adapters[1].discoverFiles()).resolves.toEqual([codexFile]);
    await expect(adapters[2].discoverFiles()).resolves.toEqual([geminiFile]);
    await expect(adapters[3].discoverFiles()).resolves.toEqual([droidFile]);
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
});
