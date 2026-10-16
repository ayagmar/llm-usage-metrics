import type * as NodePath from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { applyRepoFilter, normalizeRepoFilter } from '../../src/cli/repo-filter.js';

// The fixtures are POSIX paths; repo-filter-win32.test.ts covers Windows resolution.
vi.mock('node:path', async (importOriginal) => {
  const { posix } = await importOriginal<typeof NodePath>();
  return { ...posix, default: posix };
});

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
      { kind: 'path', input: 'c:/', path: 'C:/' },
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
    expect(select('/')).toEqual(ROOTS.filter((root) => root?.startsWith('/') === true));
  });

  it('treats \\\\host\\share as its own root, out of reach of /', () => {
    expect(select('/')).not.toContain('\\\\server\\share\\api');
    expect(select('//server/share')).toEqual(['\\\\server\\share\\api']);
    expect(select('/server/share')).toEqual([]);
  });

  it('compares drive letters in either case, and nothing else', () => {
    expect(select('c:\\src\\web')).toEqual(['C:\\src\\web', 'C:\\src\\web\\ui\\']);
    expect(select('c:/')).toEqual(['C:\\src\\web', 'C:\\src\\web\\ui\\']);
    expect(select('C:\\SRC\\web')).toEqual([]);
    expect(
      applyRepoFilter([{ repoRoot: 'c:\\src\\web' }], normalizeRepoFilter('C:\\src', context)),
    ).toHaveLength(1);
  });

  it('normalizes . and .. inside absolute values, clamped at their root', () => {
    expect(select('/w/a/../a/api')).toEqual(['/w/a/api', '/w/a/api/src']);
    expect(select('/w/./b//')).toEqual(['/w/b/api/']);
    expect(select('C:\\src\\..\\src\\web\\ui')).toEqual(['C:\\src\\web\\ui\\']);
    expect(select('C:\\..\\src\\web\\ui')).toEqual(['C:\\src\\web\\ui\\']);
    expect(select('\\\\server\\share\\x\\..\\api')).toEqual(['\\\\server\\share\\api']);
    expect(select('/w/a/api/src/../..')).toEqual([
      '/w/a/api',
      '/w/a/api/src',
      '/w/a/apix',
      '/w/a/myapi',
    ]);
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

describe('repo filter properties', () => {
  const PREFIXES = ['/', 'C:\\', 'c:/', '\\\\host\\share\\', '//host/share/'];
  const SEGMENTS = ['w', 'api', '.', '..', '', 'x y', '(unattributed)'];

  /** Every absolute root of up to three segments over PREFIXES and SEGMENTS, with both separators. */
  function* absoluteRoots(): Generator<string> {
    for (const prefix of PREFIXES) {
      const visit = function* (root: string, depth: number): Generator<string> {
        yield root;

        if (depth === 3) {
          return;
        }

        for (const segment of SEGMENTS) {
          yield* visit(`${root}${segment}`, depth + 1);
          yield* visit(`${root}${segment}/`, depth + 1);
          yield* visit(`${root}${segment}\\`, depth + 1);
        }
      };

      yield* visit(prefix, 0);
    }
  }

  it('keeps any absolute root when it is the --repo value', () => {
    for (const repoRoot of absoluteRoots()) {
      expect(
        applyRepoFilter([{ repoRoot }], normalizeRepoFilter(repoRoot, context)),
        repoRoot,
      ).toHaveLength(1);
    }
  });

  it('matches roots written with doubled separators or dot segments', () => {
    for (const repoRoot of [
      '/w//api',
      '/w/a/../a/api',
      'C:\\src\\.\\api',
      '\\\\host\\share\\x\\..\\api',
    ]) {
      expect(applyRepoFilter([{ repoRoot }], normalizeRepoFilter(repoRoot, context))).toHaveLength(
        1,
      );
    }

    expect(select('/w/a/api')).toEqual(['/w/a/api', '/w/a/api/src']);
    expect(
      applyRepoFilter([{ repoRoot: '/w/a/./api//src' }], normalizeRepoFilter('/w/a/api', context)),
    ).toHaveLength(1);
  });
});
