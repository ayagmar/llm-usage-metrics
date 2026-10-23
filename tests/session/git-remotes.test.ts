import { describe, expect, it } from 'vitest';

import { normalizeGitRemote, readOriginRemote } from '../../src/session/git-remotes.js';

describe('normalizeGitRemote', () => {
  it('gives the ssh and https URLs of one repository the same identity', () => {
    const identities = [
      'git@github.com:Me/App.git',
      'https://github.com/me/app',
      'https://github.com/me/app.git/',
      'ssh://git@github.com:22/me/app.git',
      'git+ssh://git@github.com/me/app',
    ].map(normalizeGitRemote);

    expect(new Set(identities)).toEqual(new Set(['github.com/me/app']));
  });

  it('drops credentials embedded in the URL', () => {
    expect(normalizeGitRemote('https://x-access-token:ghp_secret@github.com/me/app.git')).toBe(
      'github.com/me/app',
    );
  });

  it('keeps nested group paths', () => {
    expect(normalizeGitRemote('git@gitlab.example.com:group/sub/repo.git')).toBe(
      'gitlab.example.com/group/sub/repo',
    );
  });

  it('names no shared repository for local paths', () => {
    for (const url of ['/srv/git/app.git', '../app', 'C:\\repos\\app', 'file:///srv/git/app.git']) {
      expect(normalizeGitRemote(url)).toBeUndefined();
    }
  });
});

describe('readOriginRemote', () => {
  it('reads origin, not the other remotes', () => {
    const config = [
      '[remote "upstream"]',
      '\turl = https://github.com/other/app',
      '[remote "origin"]',
      '\turl = git@github.com:me/app.git',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\n');

    expect(readOriginRemote(config)).toBe('github.com/me/app');
    expect(
      readOriginRemote('[remote "upstream"]\n\turl = https://github.com/other/app\n'),
    ).toBeUndefined();
  });

  it('reads the forms git writes and accepts', () => {
    const configs = [
      '[Remote "origin"] # main\r\n\tURL = git@github.com:me/app.git\r\n',
      '[remote "origin"]\n\turl = "git@github.com:me/app.git"\n',
      '[remote "origin"]\n\turl = git@github.com:me/app.git ; mirror\n',
    ];

    expect(configs.map(readOriginRemote)).toEqual([
      'github.com/me/app',
      'github.com/me/app',
      'github.com/me/app',
    ]);
  });
});
