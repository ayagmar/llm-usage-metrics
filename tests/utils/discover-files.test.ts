import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../../src/utils/discover-files.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('discoverFiles', () => {
  it('recursively discovers files by extension in deterministic order', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-'));
    tempDirs.push(rootDir);

    const alphaDir = path.join(rootDir, 'alpha');
    const nestedDir = path.join(alphaDir, 'nested');
    const betaDir = path.join(rootDir, 'beta');

    await mkdir(nestedDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });

    const alphaFile = path.join(alphaDir, 'first.json');
    const nestedFile = path.join(nestedDir, 'second.json');
    const betaFile = path.join(betaDir, 'third.json');

    await writeFile(alphaFile, '{}', 'utf8');
    await writeFile(nestedFile, '{}', 'utf8');
    await writeFile(betaFile, '{}', 'utf8');
    await writeFile(path.join(rootDir, 'ignore.txt'), 'x', 'utf8');

    await expect(discoverFiles(rootDir, { extension: '.json' })).resolves.toEqual([
      alphaFile,
      nestedFile,
      betaFile,
    ]);
  });

  it('supports non-recursive discovery', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-flat-'));
    tempDirs.push(rootDir);

    const nestedDir = path.join(rootDir, 'nested');
    await mkdir(nestedDir, { recursive: true });

    const rootFile = path.join(rootDir, 'root.json');
    const nestedFile = path.join(nestedDir, 'nested.json');

    await writeFile(rootFile, '{}', 'utf8');
    await writeFile(nestedFile, '{}', 'utf8');

    await expect(discoverFiles(rootDir, { extension: '.json', recursive: false })).resolves.toEqual(
      [rootFile],
    );
  });

  it('returns empty array for missing roots', async () => {
    const missingDir = path.join(os.tmpdir(), `discover-files-missing-${Date.now()}`);

    await expect(discoverFiles(missingDir, { extension: '.json' })).resolves.toEqual([]);
  });

  it('validates extension option', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-ext-'));
    tempDirs.push(rootDir);

    await expect(discoverFiles(rootDir, { extension: '' })).rejects.toThrow(
      'discoverFiles extension must be a non-empty string',
    );
    await expect(discoverFiles(rootDir, { extension: 'json' })).rejects.toThrow(
      'discoverFiles extension must start with "."',
    );
  });

  const itIfSymlinksSupported = process.platform === 'win32' ? it.skip : it;

  itIfSymlinksSupported(
    'discovers matching files through symlinked files and directories',
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-symlink-root-'));
      tempDirs.push(rootDir);

      const targetDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-symlink-target-'));
      tempDirs.push(targetDir);

      const targetNestedDir = path.join(targetDir, 'nested');
      const targetFile = path.join(targetDir, 'linked.json');
      const targetNestedFile = path.join(targetNestedDir, 'nested.json');
      const linkedFilePath = path.join(rootDir, 'alias.json');
      const linkedDirPath = path.join(rootDir, 'linked-dir');

      await mkdir(targetNestedDir, { recursive: true });
      await writeFile(targetFile, '{}', 'utf8');
      await writeFile(targetNestedFile, '{}', 'utf8');
      await symlink(targetFile, linkedFilePath);
      await symlink(targetDir, linkedDirPath);

      await expect(discoverFiles(rootDir, { extension: '.json' })).resolves.toEqual([
        linkedFilePath,
        path.join(linkedDirPath, 'linked.json'),
        path.join(linkedDirPath, 'nested', 'nested.json'),
      ]);
    },
  );

  itIfSymlinksSupported(
    'keeps both real and symlinked directory path families when they point at the same target',
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-real-and-link-'));
      tempDirs.push(rootDir);

      const realDir = path.join(rootDir, 'real');
      const linkedDir = path.join(rootDir, 'alias');
      const nestedDir = path.join(realDir, 'nested');

      await mkdir(nestedDir, { recursive: true });
      await writeFile(path.join(realDir, 'root.json'), '{}', 'utf8');
      await writeFile(path.join(nestedDir, 'child.json'), '{}', 'utf8');
      await symlink(realDir, linkedDir);

      await expect(discoverFiles(rootDir, { extension: '.json' })).resolves.toEqual([
        path.join(linkedDir, 'nested', 'child.json'),
        path.join(linkedDir, 'root.json'),
        path.join(realDir, 'nested', 'child.json'),
        path.join(realDir, 'root.json'),
      ]);
    },
  );

  itIfSymlinksSupported(
    'matches symlinked files by the target extension when the alias name has no extension',
    async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), 'discover-files-extensionless-link-'));
      tempDirs.push(rootDir);

      const targetFile = path.join(rootDir, 'target.json');
      const linkedFile = path.join(rootDir, 'alias');

      await writeFile(targetFile, '{}', 'utf8');
      await symlink(targetFile, linkedFile);

      await expect(discoverFiles(rootDir, { extension: '.json' })).resolves.toEqual([
        linkedFile,
        targetFile,
      ]);
    },
  );
});
