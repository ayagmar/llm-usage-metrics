import { describe, expect, it } from 'vitest';

import { applyRepoFilter, normalizeRepoFilter } from '../../src/cli/repo-filter.js';

const context = { cwd: '/w/a', homeDir: '/home/dev' };

const ROOTS = [
  '/w/a/api',
  '/w/a/api/src',
  '/w/a/apix',
  '/w/a/myapi',
  '/w/b/api/',
  '/x/work/api',
  '/home/dev/notes',
  'C:\\src\\web',
  'C:\\src\\web\\ui\\',
  '\\\\server\\share\\api',
  undefined,
] as const;

const events = ROOTS.map((repoRoot) => ({ repoRoot }));

/** The repo roots `--repo <values>` keeps, in event order. */
function select(...values: string[]): (string | undefined)[] {
  return applyRepoFilter(events, normalizeRepoFilter(values, context)).map(
    (event) => event.repoRoot,
  );
}

describe('normalizeRepoFilter', () => {
  it('splits commas, trims, keeps case and drops repeats', () => {
    expect(normalizeRepoFilter([' Api , web', 'Api'], context)).toEqual([
      { kind: 'suffix', input: 'Api', suffix: 'Api' },
      { kind: 'suffix', input: 'web', suffix: 'web' },
    ]);
  });

  it('is undefined without values and rejects values that are all blank', () => {
    expect(normalizeRepoFilter(undefined)).toBeUndefined();
    expect(normalizeRepoFilter([])).toBeUndefined();
    expect(() => normalizeRepoFilter([' , '])).toThrow(
      '--repo must contain at least one non-empty project',
    );
  });

  it('resolves ., .., ./, ../, ~ and ~/ against the working and home directories', () => {
    expect(
      normalizeRepoFilter(['.', '..', './api/', '../b', '~', '~/notes', '.\\api'], context),
    ).toEqual([
      { kind: 'path', input: '.', path: '/w/a' },
      { kind: 'path', input: '..', path: '/w' },
      { kind: 'path', input: './api/', path: '/w/a/api' },
      { kind: 'path', input: '../b', path: '/w/b' },
      { kind: 'path', input: '~', path: '/home/dev' },
      { kind: 'path', input: '~/notes', path: '/home/dev/notes' },
      { kind: 'path', input: '.\\api', path: '/w/a/api' },
    ]);
  });

  it('reads a leading /, \\\\ or drive letter as a path and anything else as a suffix', () => {
    expect(
      normalizeRepoFilter(['/w/a/', 'C:\\src\\', 'c:/', '\\\\server\\share', 'work/api'], context),
    ).toEqual([
      { kind: 'path', input: '/w/a/', path: '/w/a' },
      { kind: 'path', input: 'C:\\src\\', path: 'C:/src' },
      { kind: 'path', input: 'c:/', path: 'c:/' },
      { kind: 'path', input: '\\\\server\\share', path: '//server/share' },
      { kind: 'suffix', input: 'work/api', suffix: 'work/api' },
    ]);
  });
});

describe('applyRepoFilter', () => {
  it('returns the same array when there is no filter', () => {
    expect(applyRepoFilter(events, undefined)).toBe(events);
  });

  it('matches an absolute path and the roots under it, on segment boundaries', () => {
    expect(select('/w/a/api')).toEqual(['/w/a/api', '/w/a/api/src']);
    expect(select('/w/a/api/')).toEqual(['/w/a/api', '/w/a/api/src']);
    expect(select('/w/b')).toEqual(['/w/b/api/']);
  });

  it('matches a bare root against every root on it', () => {
    expect(select('C:\\')).toEqual(['C:\\src\\web', 'C:\\src\\web\\ui\\']);
    expect(select('/')).toEqual(
      ROOTS.filter((root) => root?.startsWith('/') === true || root?.startsWith('\\\\') === true),
    );
  });

  it('matches Windows roots with either separator and a trailing one', () => {
    expect(select('C:/src/web')).toEqual(['C:\\src\\web', 'C:\\src\\web\\ui\\']);
    expect(select('C:\\src\\web\\ui')).toEqual(['C:\\src\\web\\ui\\']);
    expect(select('\\\\server\\share')).toEqual(['\\\\server\\share\\api']);
  });

  it('matches relative and home paths after resolving them', () => {
    expect(select('./api')).toEqual(['/w/a/api', '/w/a/api/src']);
    expect(select('../b')).toEqual(['/w/b/api/']);
    expect(select('~/notes')).toEqual(['/home/dev/notes']);
  });

  it('matches a name or label as a whole-segment suffix, without the roots under it', () => {
    expect(select('api')).toEqual([
      '/w/a/api',
      '/w/b/api/',
      '/x/work/api',
      '\\\\server\\share\\api',
    ]);
    expect(select('work/api')).toEqual(['/x/work/api']);
    expect(select('a/api')).toEqual(['/w/a/api']);
    expect(select('web')).toEqual(['C:\\src\\web']);
    expect(select('src')).toEqual(['/w/a/api/src']);
    expect(select('pi')).toEqual([]);
  });

  it('keeps case: a suffix of another case selects nothing', () => {
    expect(select('API')).toEqual([]);
  });

  it('selects events without a root with (unattributed)', () => {
    expect(select('(unattributed)')).toEqual([undefined]);
    expect(select('(unattributed)', 'myapi')).toEqual(['/w/a/myapi', undefined]);
  });
});
