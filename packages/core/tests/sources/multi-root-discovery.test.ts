import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverFilesAcrossRoots,
  resolveRootDirs,
} from '../../src/sources/multi-root-discovery.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'multi-root-discovery-'));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('multi-root discovery helpers', () => {
  it('resolves override and default roots', () => {
    expect(resolveRootDirs('/override', ['/default-a', '/default-b'])).toEqual(['/override']);
    expect(resolveRootDirs(undefined, ['/default-a', '/default-b'])).toEqual([
      '/default-a',
      '/default-b',
    ]);
    expect(resolveRootDirs('', ['/default'])).toEqual(['']);
  });

  it('concatenates root results in root order', async () => {
    const result = await discoverFilesAcrossRoots({
      rootDirs: [' /root-b ', '/root-a'],
      requireDir: false,
      directoryLabel: 'Test directory',
      discoverInRoot: async (rootDir) => [`${rootDir}/2.jsonl`, `${rootDir}/1.jsonl`],
    });

    expect(result).toEqual([
      '/root-b/2.jsonl',
      '/root-b/1.jsonl',
      '/root-a/2.jsonl',
      '/root-a/1.jsonl',
    ]);
  });

  it('lets the root discoverer decide missing-root behavior when not required', async () => {
    const result = await discoverFilesAcrossRoots({
      rootDirs: ['/missing-root'],
      requireDir: false,
      directoryLabel: 'Test directory',
      discoverInRoot: async (rootDir) => [`${rootDir}/synthetic.jsonl`],
    });

    expect(result).toEqual(['/missing-root/synthetic.jsonl']);
  });

  it('rejects blank roots with the adapter label', async () => {
    await expect(
      discoverFilesAcrossRoots({
        rootDirs: ['  '],
        requireDir: false,
        directoryLabel: 'Test directory',
        discoverInRoot: async () => [],
      }),
    ).rejects.toThrow('Test directory must be a non-empty path');
  });

  it('rejects missing required roots with the adapter label', async () => {
    const tempDir = await createTempDir();
    const missingDir = path.join(tempDir, 'missing');

    await expect(
      discoverFilesAcrossRoots({
        rootDirs: [missingDir],
        requireDir: true,
        directoryLabel: 'Test directory',
        discoverInRoot: async () => [],
      }),
    ).rejects.toThrow(`Test directory is missing or unreadable: ${missingDir}`);
  });

  it('rejects required roots that are not directories', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'not-a-directory');
    await writeFile(filePath, 'content', 'utf8');

    await expect(
      discoverFilesAcrossRoots({
        rootDirs: [filePath],
        requireDir: true,
        directoryLabel: 'Test directory',
        discoverInRoot: async () => [],
      }),
    ).rejects.toThrow(`Test directory is not a directory: ${filePath}`);
  });

  it('sorts across roots when requested', async () => {
    const result = await discoverFilesAcrossRoots({
      rootDirs: ['/root-b', '/root-a'],
      requireDir: false,
      directoryLabel: 'Test directory',
      discoverInRoot: async (rootDir) => [`${rootDir}/2.jsonl`, `${rootDir}/1.jsonl`],
      sortAcrossRoots: true,
    });

    expect(result).toEqual([
      '/root-a/1.jsonl',
      '/root-a/2.jsonl',
      '/root-b/1.jsonl',
      '/root-b/2.jsonl',
    ]);
  });
});
