import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverJsonlFiles } from '../../src/utils/discover-jsonl-files.js';

const tempDirs: string[] = [];
const itWhenUnix = process.platform === 'win32' ? it.skip : it;

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('discoverJsonlFiles', () => {
  it('recursively discovers jsonl files in deterministic order', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-jsonl-'));
    tempDirs.push(rootDir);

    const alphaDir = path.join(rootDir, 'alpha');
    const alphaNestedDir = path.join(alphaDir, 'nested');
    const betaDir = path.join(rootDir, 'beta');

    await mkdir(alphaNestedDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });

    const alphaFile = path.join(alphaDir, 'first.jsonl');
    const alphaNestedFile = path.join(alphaNestedDir, 'second.jsonl');
    const betaFile = path.join(betaDir, 'third.jsonl');

    await writeFile(alphaFile, '{}\n', 'utf8');
    await writeFile(alphaNestedFile, '{}\n', 'utf8');
    await writeFile(betaFile, '{}\n', 'utf8');
    await writeFile(path.join(rootDir, 'ignore.txt'), 'not-jsonl\n', 'utf8');

    const discoveredFiles = await discoverJsonlFiles(rootDir);

    expect(discoveredFiles).toEqual([alphaFile, alphaNestedFile, betaFile]);
  });

  itWhenUnix('sorts file names by code point for locale-independent ordering', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-jsonl-code-point-'));
    tempDirs.push(rootDir);

    const upperFile = path.join(rootDir, 'A.jsonl');
    const lowerFile = path.join(rootDir, 'a.jsonl');

    await writeFile(lowerFile, '{}\n', 'utf8');
    await writeFile(upperFile, '{}\n', 'utf8');

    const discoveredFiles = await discoverJsonlFiles(rootDir);

    expect(discoveredFiles).toEqual([upperFile, lowerFile]);
  });

  it('discovers jsonl files case-insensitively by extension', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-jsonl-extension-case-'));
    tempDirs.push(rootDir);

    const lowerFile = path.join(rootDir, 'lower.jsonl');
    const upperFile = path.join(rootDir, 'upper.JSONL');

    await writeFile(lowerFile, '{}\n', 'utf8');
    await writeFile(upperFile, '{}\n', 'utf8');

    const discoveredFiles = await discoverJsonlFiles(rootDir);

    expect(discoveredFiles).toEqual([lowerFile, upperFile]);
  });

  it('returns an empty list when the root directory does not exist', async () => {
    const missingDir = path.join(os.tmpdir(), `discover-jsonl-missing-${Date.now()}`);

    await expect(discoverJsonlFiles(missingDir)).resolves.toEqual([]);
  });

  it('propagates non-ENOENT discovery errors', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-jsonl-errors-'));
    tempDirs.push(rootDir);

    const regularFile = path.join(rootDir, 'file.jsonl');
    await writeFile(regularFile, '{}\n', 'utf8');

    await expect(discoverJsonlFiles(regularFile)).rejects.toThrow();
  });

  itWhenUnix(
    'skips unreadable nested directories and continues walking readable paths',
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-jsonl-permissions-'));
      tempDirs.push(rootDir);

      const readableDir = path.join(rootDir, 'readable');
      const blockedDir = path.join(rootDir, 'blocked');

      await mkdir(readableDir, { recursive: true });
      await mkdir(blockedDir, { recursive: true });

      const readableFile = path.join(readableDir, 'keep.jsonl');
      const blockedFile = path.join(blockedDir, 'hidden.jsonl');

      await writeFile(readableFile, '{}\n', 'utf8');
      await writeFile(blockedFile, '{}\n', 'utf8');

      await chmod(blockedDir, 0o000);

      try {
        const discoveredFiles = await discoverJsonlFiles(rootDir);
        expect(discoveredFiles).toEqual([readableFile]);
      } finally {
        await chmod(blockedDir, 0o755);
      }
    },
  );
});
