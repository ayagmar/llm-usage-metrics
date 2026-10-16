import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = path.resolve('scripts/check-dist-size.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Runs the size check in a package whose two shipped dist files have the given sizes. */
async function runCheck(indexBytes: number, binBytes = 100) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'check-dist-size-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'dist'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ files: ['dist/bin.js', 'dist/index.js', 'README.md'] }),
  );
  await writeFile(path.join(dir, 'dist/index.js'), Buffer.alloc(indexBytes));
  await writeFile(path.join(dir, 'dist/bin.js'), Buffer.alloc(binBytes));

  return spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' });
}

describe('check-dist-size', () => {
  it('passes a dist within the budget and fails one byte over it', async () => {
    const within = await runCheck(1_000);

    expect(within.status).toBe(0);
    const budget = Number(
      /dist total: 1,100 of ([\d,]+) bytes/u.exec(within.stdout)?.[1]?.replaceAll(',', ''),
    );
    expect(budget).toBeGreaterThan(1_100);

    const over = await runCheck(budget + 1 - 100, 100);

    expect(over.status).toBe(1);
    expect(over.stderr).toContain('over budget by 1 bytes');
  });
});
