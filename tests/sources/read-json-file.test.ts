import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_JSON_TRANSCRIPT_BYTES,
  readBoundedJsonFile,
} from '../../src/sources/read-json-file.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'read-json-file-test-'));
  tempDirs.push(tempDir);
  return tempDir;
}

describe('readBoundedJsonFile', () => {
  it('parses a valid JSON file', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'valid.json');
    await writeFile(filePath, '{"sessionId":"abc"}', 'utf8');

    expect(await readBoundedJsonFile(filePath)).toEqual({
      ok: true,
      value: { sessionId: 'abc' },
    });
  });

  it('reports malformed JSON as json_parse_error', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'broken.json');
    await writeFile(filePath, '{not json', 'utf8');

    expect(await readBoundedJsonFile(filePath)).toEqual({
      ok: false,
      reason: 'json_parse_error',
    });
  });

  it('reports a missing file as json_parse_error', async () => {
    const tempDir = await createTempDir();

    expect(await readBoundedJsonFile(path.join(tempDir, 'missing.json'))).toEqual({
      ok: false,
      reason: 'json_parse_error',
    });
  });

  it('refuses oversized files without reading them', async () => {
    const tempDir = await createTempDir();
    const filePath = path.join(tempDir, 'huge.json');
    await writeFile(filePath, '{}', 'utf8');
    // Sparse-extend the file so its stat size exceeds the cap without real I/O.
    await truncate(filePath, MAX_JSON_TRANSCRIPT_BYTES + 1);

    expect(await readBoundedJsonFile(filePath)).toEqual({
      ok: false,
      reason: 'file_too_large',
    });
  });
});
