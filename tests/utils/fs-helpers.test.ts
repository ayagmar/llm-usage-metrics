import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureDirectory, writeFileAtomic } from '../../src/utils/fs-helpers.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fs-helpers-'));
  tempDirs.push(tempDir);
  return tempDir;
}

describe('ensureDirectory', () => {
  it('creates every missing level and accepts an existing directory', async () => {
    const tempDir = await createTempDir();
    const nested = path.join(tempDir, 'a', 'b', 'c');

    await ensureDirectory(nested);
    await ensureDirectory(nested);

    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('applies the mode to the levels it creates', async () => {
    const tempDir = await createTempDir();
    const nested = path.join(tempDir, 'private', 'store');

    await ensureDirectory(nested, 0o700);

    expect((await stat(path.join(tempDir, 'private'))).mode & 0o777).toBe(0o700);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it('fails when a file sits where a directory should be', async () => {
    const tempDir = await createTempDir();
    await writeFile(path.join(tempDir, 'file'), 'x');

    await expect(ensureDirectory(path.join(tempDir, 'file', 'sub'))).rejects.toThrow();
    await expect(ensureDirectory(path.join(tempDir, 'file'))).rejects.toThrow(/EEXIST/u);
  });

  // Node's recursive mkdir never settles here: mkdir under /proc fails with ENOENT
  // although /proc exists. ensureDirectory must fail instead of hanging the CLI.
  it.runIf(process.platform === 'linux')(
    'fails fast for a path under /proc',
    async () => {
      await expect(ensureDirectory('/proc/llm-usage-test/store')).rejects.toThrow(/ENOENT/u);
    },
    2_000,
  );
});

describe('writeFileAtomic', () => {
  it('replaces the file contents and leaves no temp file behind', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'cache.json');
    await writeFile(filePath, 'old', 'utf8');

    await writeFileAtomic(filePath, 'new');

    await expect(readFile(filePath, 'utf8')).resolves.toBe('new');
    await expect(readdir(tempDir)).resolves.toEqual(['cache.json']);
  });

  it('removes the temp file when the rename fails', async () => {
    const tempDir = await createTempDir();
    const directoryInTheWay = path.join(tempDir, 'cache.json');
    await mkdir(directoryInTheWay);

    await expect(writeFileAtomic(directoryInTheWay, 'new')).rejects.toThrow();
    await expect(readdir(tempDir)).resolves.toEqual(['cache.json']);
  });
});
