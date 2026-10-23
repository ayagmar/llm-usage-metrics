import { describe, expect, it } from 'vitest';

import { createProjectAliasResolver } from '../../src/session/project-aliases.js';

describe('createProjectAliasResolver', () => {
  const aliases = [
    { path: '/home/me/projects', aliases: ['/home/me/Projects/Personal'] },
    { path: '/home/me/projects/orange', aliases: ['/home/me/Projects/Personal/Orange'] },
  ];

  it('moves a key at or below an alias, the nearest alias winning', () => {
    const aliasOf = createProjectAliasResolver(aliases, 'linux');

    expect(aliasOf('/home/me/Projects/Personal')).toBe('/home/me/projects');
    expect(aliasOf('/home/me/Projects/Personal/app/site')).toBe('/home/me/projects/app/site');
    expect(aliasOf('/home/me/Projects/Personal/Orange/api')).toBe('/home/me/projects/orange/api');
  });

  it('leaves keys outside every alias, and folders that only share a prefix', () => {
    const aliasOf = createProjectAliasResolver(aliases, 'linux');

    expect(aliasOf('/home/me/Projects/Personalized/app')).toBeUndefined();
    expect(aliasOf('/home/me/projects/app')).toBeUndefined();
    expect(aliasOf('/home/me/projects/personal/app')).toBeUndefined();
  });

  it('ignores case and separators on Windows', () => {
    const aliasOf = createProjectAliasResolver(
      [{ path: 'C:\\Users\\me\\projects', aliases: ['C:\\Users\\me\\Projects\\Personal'] }],
      'win32',
    );

    expect(aliasOf('c:\\users\\ME\\projects\\personal\\app')).toBe('C:\\Users\\me\\projects\\app');
  });
});
