import { lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeShareFile } from '../../src/cli/share-artifact.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';

describe('writeShareFile', () => {
  const environment = useIsolatedEnvironment();

  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(environment.rootDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces an earlier report of the same name', async () => {
    await writeShareFile('report.html', 'old');
    const written = await writeShareFile('report.html', 'new');

    expect(written).toBe(path.join(environment.rootDir, 'report.html'));
    expect(await readFile(written, 'utf8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a symlink at the report name instead of writing through it, owner-only',
    async () => {
      const victim = path.join(environment.rootDir, 'victim.txt');
      await writeFile(victim, 'VICTIM');
      await symlink(victim, path.join(environment.rootDir, 'linked.html'));

      const written = await writeShareFile('linked.html', '<html></html>');
      const stats = await lstat(written);

      expect(await readFile(victim, 'utf8')).toBe('VICTIM');
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o600);
      expect(await readFile(written, 'utf8')).toBe('<html></html>');
    },
  );
});
