import { describe, expect, it } from 'vitest';

import { createProjectAliasResolver } from '../../src/session/project-aliases.js';

describe('createProjectAliasResolver', () => {
  const aliases = [
    { path: '/home/me/projects', aliases: ['/home/me/Projects/Personal'] },
    { path: '/home/me/projects/orange', aliases: ['/home/me/Projects/Personal/Orange'] },
  ];

  it('moves a key at or below an alias, the nearest alias winning', () => {
    const aliasOf = createProjectAliasResolver(aliases);

    expect(aliasOf('/home/me/Projects/Personal')).toBe('/home/me/projects');
    expect(aliasOf('/home/me/Projects/Personal/app/site')).toBe('/home/me/projects/app/site');
    expect(aliasOf('/home/me/Projects/Personal/Orange/api')).toBe('/home/me/projects/orange/api');
  });

  it('leaves keys outside every alias, and folders that only share a prefix', () => {
    const aliasOf = createProjectAliasResolver(aliases);

    expect(aliasOf('/home/me/Projects/Personalized/app')).toBeUndefined();
    expect(aliasOf('/home/me/projects/app')).toBeUndefined();
    expect(aliasOf('/home/me/projects/personal/app')).toBeUndefined();
  });

  it('keeps usage at or below a target, even inside an alias', () => {
    const aliasOf = createProjectAliasResolver([
      { path: '/home/me/projects/app', aliases: ['/home/me/projects'] },
    ]);

    expect(aliasOf('/home/me/projects/app/site')).toBeUndefined();
    expect(aliasOf('/home/me/projects/tool')).toBe('/home/me/projects/app/tool');
  });

  it('keeps the first target of an alias listed twice', () => {
    const aliasOf = createProjectAliasResolver([
      { path: '/a', aliases: ['/old'] },
      { path: '/b', aliases: ['/old'] },
    ]);

    expect(aliasOf('/old/app')).toBe('/a/app');
  });

  it('compares Windows paths without case or separator, whichever host reads them', () => {
    const aliasOf = createProjectAliasResolver([
      { path: '/home/me/projects', aliases: ['C:\\Users\\me\\Projects\\Personal'] },
    ]);

    expect(aliasOf('c:/users/ME/projects/personal/app')).toBe('/home/me/projects/app');
    expect(aliasOf('/home/me/Projects/Personal/app')).toBeUndefined();
  });
});
