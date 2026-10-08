import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getUserDataRootDir } from '../../src/utils/data-root-dir.js';

describe('getUserDataRootDir', () => {
  it('prefers XDG_DATA_HOME when set', () => {
    const dataDir = getUserDataRootDir({ XDG_DATA_HOME: '/tmp/xdg-data' }, 'linux', '/home/test');

    expect(dataDir).toBe('/tmp/xdg-data');
  });

  it('uses LOCALAPPDATA on win32 when XDG_DATA_HOME is absent', () => {
    const dataDir = getUserDataRootDir(
      { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      'win32',
      'C:\\Users\\test',
    );

    expect(dataDir).toBe('C:\\Users\\test\\AppData\\Local');
  });

  it('falls back to homedir/.local/share otherwise', () => {
    const dataDir = getUserDataRootDir({}, 'linux', '/home/test');

    expect(dataDir).toBe(path.join('/home/test', '.local', 'share'));
  });
  it('ignores a relative XDG_DATA_HOME, as the XDG spec requires', () => {
    expect(getUserDataRootDir({ XDG_DATA_HOME: 'relative/dir' }, 'linux', '/home/test')).toBe(
      path.join('/home/test', '.local', 'share'),
    );
  });
});
