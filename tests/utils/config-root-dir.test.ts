import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getUserConfigRootDir } from '../../src/utils/config-root-dir.js';

describe('getUserConfigRootDir', () => {
  it('prefers XDG_CONFIG_HOME when set', () => {
    const configDir = getUserConfigRootDir(
      { XDG_CONFIG_HOME: '/tmp/xdg-config' },
      'linux',
      '/home/test',
    );

    expect(configDir).toBe('/tmp/xdg-config');
  });

  it('uses APPDATA on win32 when XDG_CONFIG_HOME is absent', () => {
    const configDir = getUserConfigRootDir(
      { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      'win32',
      'C:\\Users\\test',
    );

    expect(configDir).toBe('C:\\Users\\test\\AppData\\Roaming');
  });

  it('falls back to homedir/.config otherwise', () => {
    const configDir = getUserConfigRootDir({}, 'linux', '/home/test');

    expect(configDir).toBe(path.join('/home/test', '.config'));
  });
});
