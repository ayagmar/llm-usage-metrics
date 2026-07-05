import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultOpenCodeDbPathCandidates } from '../../src/sources/opencode/opencode-db-path-resolver.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('getDefaultOpenCodeDbPathCandidates', () => {
  it('builds deterministic Linux candidate paths with XDG override precedence', () => {
    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'linux',
      homeDir: '/home/test-user',
      env: { XDG_DATA_HOME: '/var/lib/test-user' },
    });

    expect(candidates).toEqual([
      '/var/lib/test-user/opencode/opencode.db',
      '/var/lib/test-user/opencode/db.sqlite',
      '/home/test-user/.opencode/opencode.db',
      '/home/test-user/.opencode/db.sqlite',
    ]);
  });

  it('ignores blank XDG_DATA_HOME values and falls back to the default base path', () => {
    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'linux',
      homeDir: '/home/test-user',
      env: { XDG_DATA_HOME: '   ' },
    });

    expect(candidates).toEqual([
      '/home/test-user/.local/share/opencode/opencode.db',
      '/home/test-user/.local/share/opencode/db.sqlite',
      '/home/test-user/.opencode/opencode.db',
      '/home/test-user/.opencode/db.sqlite',
    ]);
  });

  it('builds deterministic macOS candidate paths', () => {
    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'darwin',
      homeDir: '/Users/test-user',
      env: {},
    });

    expect(candidates).toEqual([
      '/Users/test-user/Library/Application Support/opencode/opencode.db',
      '/Users/test-user/Library/Application Support/opencode/db.sqlite',
      '/Users/test-user/.opencode/opencode.db',
      '/Users/test-user/.opencode/db.sqlite',
    ]);
  });

  it('builds deterministic Windows candidate paths from APPDATA first', () => {
    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'win32',
      homeDir: 'C:\\Users\\test-user',
      env: { APPDATA: 'C:\\Users\\test-user\\AppData\\Roaming' },
    });

    expect(candidates).toEqual([
      path.join('C:\\Users\\test-user\\AppData\\Roaming', 'opencode', 'opencode.db'),
      path.join('C:\\Users\\test-user\\AppData\\Roaming', 'opencode', 'db.sqlite'),
      path.join('C:\\Users\\test-user', '.opencode', 'opencode.db'),
      path.join('C:\\Users\\test-user', '.opencode', 'db.sqlite'),
    ]);
  });

  it('ignores blank Windows env path overrides before falling back', () => {
    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'win32',
      homeDir: 'C:\\Users\\test-user',
      env: {
        APPDATA: '   ',
        LOCALAPPDATA: '',
        USERPROFILE: 'C:\\Users\\test-user',
      },
    });

    expect(candidates).toEqual([
      path.join('C:\\Users\\test-user', 'AppData', 'Roaming', 'opencode', 'opencode.db'),
      path.join('C:\\Users\\test-user', 'AppData', 'Roaming', 'opencode', 'db.sqlite'),
      path.join('C:\\Users\\test-user', '.opencode', 'opencode.db'),
      path.join('C:\\Users\\test-user', '.opencode', 'db.sqlite'),
    ]);
  });

  it('lists on-disk channel databases after opencode.db and before db.sqlite', async () => {
    const xdgDataHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-xdg-'));
    tempDirs.push(xdgDataHome);
    const opencodeDir = path.join(xdgDataHome, 'opencode');
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(path.join(opencodeDir, 'opencode-stable.db'), '', 'utf8');
    await writeFile(path.join(opencodeDir, 'opencode-nightly.db'), '', 'utf8');
    await writeFile(path.join(opencodeDir, 'unrelated.txt'), '', 'utf8');

    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'linux',
      homeDir: '/home/test-user',
      env: { XDG_DATA_HOME: xdgDataHome },
    });

    expect(candidates).toEqual([
      path.join(opencodeDir, 'opencode.db'),
      path.join(opencodeDir, 'opencode-nightly.db'),
      path.join(opencodeDir, 'opencode-stable.db'),
      path.join(opencodeDir, 'db.sqlite'),
      '/home/test-user/.opencode/opencode.db',
      '/home/test-user/.opencode/db.sqlite',
    ]);
  });

  it('falls back to home-directory candidates when no Windows roaming base is available', () => {
    const candidates = getDefaultOpenCodeDbPathCandidates({
      platform: 'win32',
      homeDir: 'C:\\Users\\test-user',
      env: {},
    });

    expect(candidates).toEqual([
      path.join('C:\\Users\\test-user', '.opencode', 'opencode.db'),
      path.join('C:\\Users\\test-user', '.opencode', 'db.sqlite'),
    ]);
  });
});
