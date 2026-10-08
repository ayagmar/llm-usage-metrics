import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getUserCacheRootDir } from '../../src/utils/cache-root-dir.js';

describe('getUserCacheRootDir', () => {
  it('prefers XDG_CACHE_HOME when set', () => {
    const cacheDir = getUserCacheRootDir(
      { XDG_CACHE_HOME: '/tmp/xdg-cache' },
      'linux',
      '/home/test',
    );

    expect(cacheDir).toBe('/tmp/xdg-cache');
  });

  it('uses LOCALAPPDATA on win32 when XDG_CACHE_HOME is absent', () => {
    const cacheDir = getUserCacheRootDir(
      { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
      'win32',
      'C:\\Users\\test',
    );

    expect(cacheDir).toBe('C:\\Users\\test\\AppData\\Local');
  });

  it('falls back to homedir/.cache otherwise', () => {
    const cacheDir = getUserCacheRootDir({}, 'linux', '/home/test');

    expect(cacheDir).toBe(path.join('/home/test', '.cache'));
  });
  it('ignores a relative XDG_CACHE_HOME, as the XDG spec requires', () => {
    expect(getUserCacheRootDir({ XDG_CACHE_HOME: 'relative/dir' }, 'linux', '/home/test')).toBe(
      path.join('/home/test', '.cache'),
    );
  });
});
