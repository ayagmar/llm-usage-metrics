import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readFirstLine } from '../../src/utils/read-first-line.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('readFirstLine', () => {
  it('reads only the first line and rejects lines beyond the byte limit', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'read-first-line-'));
    tempDirs.push(tempDir);
    const multiLinePath = path.join(tempDir, 'multi.jsonl');
    const singleLinePath = path.join(tempDir, 'single.jsonl');
    await writeFile(multiLinePath, '{"type":"session"}\n{"type":"message"}\n', 'utf8');
    await writeFile(singleLinePath, 'x'.repeat(32), 'utf8');

    expect(await readFirstLine(multiLinePath)).toBe('{"type":"session"}');
    expect(await readFirstLine(singleLinePath)).toBe('x'.repeat(32));
    expect(await readFirstLine(singleLinePath, 16)).toBeUndefined();
    expect(await readFirstLine(path.join(tempDir, 'missing.jsonl'))).toBeUndefined();
  });
});
