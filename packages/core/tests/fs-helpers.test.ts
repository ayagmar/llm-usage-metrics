import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  pathExists,
  pathIsDirectory,
  pathIsFile,
  pathReadable,
  pathStat,
} from '../src/utils/fs-helpers.js';
import { canonicalTmpdir } from './helpers/tmp.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(canonicalTmpdir(), 'core-fs-helpers-'));
  tempDirs.push(tempDir);
  return tempDir;
}

describe('read-only path checks', () => {
  it('tell a file from a directory', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'session.jsonl');
    const directoryPath = path.join(tempDir, 'sessions');
    await writeFile(filePath, '{}\n', 'utf8');
    await mkdir(directoryPath);

    expect(await pathExists(filePath)).toBe(true);
    expect(await pathReadable(filePath)).toBe(true);
    expect(await pathIsFile(filePath)).toBe(true);
    expect(await pathIsDirectory(filePath)).toBe(false);
    expect((await pathStat(filePath))?.size).toBe(3);

    expect(await pathIsDirectory(directoryPath)).toBe(true);
    expect(await pathIsFile(directoryPath)).toBe(false);
    expect((await pathStat(directoryPath))?.isDirectory()).toBe(true);
  });

  it('report a missing path as absent instead of throwing', async () => {
    const missingPath = path.join(await createTempDir(), 'missing');

    expect(await pathExists(missingPath)).toBe(false);
    expect(await pathReadable(missingPath)).toBe(false);
    expect(await pathIsFile(missingPath)).toBe(false);
    expect(await pathIsDirectory(missingPath)).toBe(false);
    expect(await pathStat(missingPath)).toBeUndefined();
  });
});
