import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeFileAtomic } from '../src/utils/fs-helpers.js';

const fsHooks = vi.hoisted(() => ({ renameRefusals: 0 }));

// Windows refuses to replace a file while another process has it open (a reader, an
// antivirus scan of the new temp file), with EPERM, for as long as that handle stays open.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');

  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsHooks.renameRefusals > 0) {
        fsHooks.renameRefusals -= 1;
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }

      return actual.rename(...args);
    },
  };
});

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'fs-helpers-busy-'));
});

afterEach(async () => {
  fsHooks.renameRefusals = 0;
  await rm(tempDir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('replaces a file that another process holds open for a moment', async () => {
    const filePath = path.join(tempDir, 'update-check.json');
    await writeFile(filePath, 'old', 'utf8');
    fsHooks.renameRefusals = 2;

    await writeFileAtomic(filePath, 'new');

    await expect(readFile(filePath, 'utf8')).resolves.toBe('new');
    await expect(readdir(tempDir)).resolves.toEqual(['update-check.json']);
  });
});
