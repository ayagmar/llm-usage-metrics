import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { USAGE_EVENT_NORMALIZATION_VERSION } from '../../src/domain/usage-event.js';
import {
  CORE_EVENT_VERSION,
  getFileByteSize,
  getNewestFingerprintMtimeMs,
  getFileFingerprint,
  getParserVersion,
  getPrimaryFingerprintByteSize,
  type FileFingerprint,
} from '../../src/sources/parse-fingerprint.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { readFrom } from '../helpers/fake-read.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'parse-fingerprint-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function createAdapter(options: {
  parserVersion?: number;
  dependencies?: (filePath: string) => string[];
}): SourceAdapter {
  const { dependencies } = options;

  return {
    id: 'pi',
    parserVersion: options.parserVersion,
    discoverFiles: () => Promise.resolve([]),
    read: readFrom(() => []),
    ...(dependencies
      ? { getParseDependencies: (filePath: string) => Promise.resolve(dependencies(filePath)) }
      : {}),
  };
}

describe('getParserVersion', () => {
  it('keys stored events by normalization and parser version, defaulting the parser to 1', () => {
    expect(CORE_EVENT_VERSION).toBe(USAGE_EVENT_NORMALIZATION_VERSION);
    expect(getParserVersion({ parserVersion: 4 })).toBe(
      `n${String(USAGE_EVENT_NORMALIZATION_VERSION)}.p4`,
    );
    expect(getParserVersion({})).toBe(`n${String(USAGE_EVENT_NORMALIZATION_VERSION)}.p1`);
  });
});

describe('getFileFingerprint', () => {
  it('fingerprints the file first, then its distinct dependencies in code-point order', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'session.jsonl');
    const upperDependency = path.join(tempDir, 'Z-parent.jsonl');
    const lowerDependency = path.join(tempDir, 'a-parent.jsonl');
    await writeFile(filePath, 'abc', 'utf8');
    await writeFile(upperDependency, 'abcdef', 'utf8');
    await writeFile(lowerDependency, '', 'utf8');

    const fingerprint = await getFileFingerprint(
      createAdapter({
        parserVersion: 2,
        dependencies: (primary) => [lowerDependency, primary, upperDependency, lowerDependency],
      }),
      filePath,
    );

    expect(fingerprint?.parserVersion).toBe(getParserVersion({ parserVersion: 2 }));
    expect(
      fingerprint?.dependencies.map(({ path: dependencyPath, exists, size }) => ({
        dependencyPath,
        exists,
        size,
      })),
    ).toEqual([
      { dependencyPath: filePath, exists: true, size: 3 },
      { dependencyPath: upperDependency, exists: true, size: 6 },
      { dependencyPath: lowerDependency, exists: true, size: 0 },
    ]);
    expect(fingerprint?.dependencies.every((dependency) => dependency.mtimeMs !== undefined)).toBe(
      true,
    );
  });

  // The event store keys stored events on this JSON: renaming a field, reordering it or
  // changing the parser version format would re-parse every file once for every user.
  it('serializes to the JSON the event store keys on', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'session.jsonl');
    const missingDependency = path.join(tempDir, 'parent.jsonl');
    await writeFile(filePath, 'abc', 'utf8');
    await utimes(filePath, 1_700_000_000, 1_700_000_000);

    const fingerprint = await getFileFingerprint(
      createAdapter({ parserVersion: 3, dependencies: () => [missingDependency] }),
      filePath,
    );

    expect(JSON.stringify(fingerprint)).toBe(
      `{"parserVersion":"n4.p3","dependencies":[` +
        `{"path":${JSON.stringify(filePath)},"exists":true,"size":3,"mtimeMs":1700000000000},` +
        `{"path":${JSON.stringify(missingDependency)},"exists":false}]}`,
    );
  });

  it('records a missing dependency as absent so its later creation invalidates the file', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'session.jsonl');
    const missingDependency = path.join(tempDir, 'missing-parent.jsonl');
    await writeFile(filePath, 'abc', 'utf8');

    const fingerprint = await getFileFingerprint(
      createAdapter({ dependencies: () => [missingDependency] }),
      filePath,
    );

    expect(fingerprint?.dependencies[1]).toEqual({ path: missingDependency, exists: false });
  });

  it('has no fingerprint when the file itself is missing', async () => {
    const tempDir = await createTempDir();

    await expect(
      getFileFingerprint(createAdapter({}), path.join(tempDir, 'gone.jsonl')),
    ).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'has no fingerprint when a dependency cannot be inspected for a reason other than absence',
    async () => {
      const tempDir = await createTempDir();
      const filePath = path.join(tempDir, 'session.jsonl');
      await writeFile(filePath, 'abc', 'utf8');
      // A path below a regular file fails with ENOTDIR, not ENOENT.
      const unreadableDependency = path.join(filePath, 'child.json');

      await expect(
        getFileFingerprint(createAdapter({ dependencies: () => [unreadableDependency] }), filePath),
      ).resolves.toBeUndefined();
    },
  );
});

describe('fingerprint size and mtime helpers', () => {
  function fingerprintOf(dependencies: FileFingerprint['dependencies']): FileFingerprint {
    return { parserVersion: 'n1.p1', dependencies };
  }

  it('reads a file size, and 0 for a file that is gone', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'session.jsonl');
    await writeFile(filePath, 'abcd', 'utf8');

    await expect(getFileByteSize(filePath)).resolves.toBe(4);
    await expect(getFileByteSize(path.join(tempDir, 'gone.jsonl'))).resolves.toBe(0);
  });

  it('takes the primary size only from an existing primary with a size', () => {
    expect(getPrimaryFingerprintByteSize(undefined)).toBeUndefined();
    expect(getPrimaryFingerprintByteSize(fingerprintOf([]))).toBeUndefined();
    expect(
      getPrimaryFingerprintByteSize(fingerprintOf([{ path: '/a', exists: false }])),
    ).toBeUndefined();
    expect(
      getPrimaryFingerprintByteSize(fingerprintOf([{ path: '/a', exists: true }])),
    ).toBeUndefined();
    expect(
      getPrimaryFingerprintByteSize(
        fingerprintOf([
          { path: '/a', exists: true, size: 12 },
          { path: '/b', exists: true, size: 99 },
        ]),
      ),
    ).toBe(12);
    expect(
      getPrimaryFingerprintByteSize(fingerprintOf([{ path: '/a', exists: true, size: -5 }])),
    ).toBe(0);
  });

  it('takes the newest mtime among existing dependencies', () => {
    expect(
      getNewestFingerprintMtimeMs(
        fingerprintOf([
          { path: '/a', exists: true, size: 1, mtimeMs: 100 },
          { path: '/b', exists: false },
          { path: '/c', exists: true, size: 1, mtimeMs: 300 },
          { path: '/d', exists: true, size: 1 },
        ]),
      ),
    ).toBe(300);
    expect(getNewestFingerprintMtimeMs(fingerprintOf([{ path: '/b', exists: false }]))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });
});
