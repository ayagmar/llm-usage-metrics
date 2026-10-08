import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileAtomic } from '../../src/utils/fs-helpers.js';

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
