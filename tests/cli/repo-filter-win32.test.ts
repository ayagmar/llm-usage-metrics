import type * as NodePath from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { applyRepoFilter, normalizeRepoFilter } from '../../src/cli/repo-filter.js';

// `--repo` as it resolves on Windows, whatever platform runs the tests.
vi.mock('node:path', async (importOriginal) => {
  const { win32 } = await importOriginal<typeof NodePath>();
  return { ...win32, default: win32 };
});

const context = { cwd: 'C:\\Users\\dev\\work', homeDir: 'C:\\Users\\dev' };

// Repository roots as the adapters record them on Windows.
const ROOTS = [
  'C:\\Users\\dev\\work\\api',
  'C:\\Users\\dev\\work\\api\\src',
  'c:\\Users\\dev\\work\\web\\',
  'C:\\Users\\dev\\notes',
  'D:\\Users\\dev\\work\\api',
  '\\\\server\\share\\api',
] as const;

function select(value: string, cwd = context.cwd): string[] {
  return applyRepoFilter(
    ROOTS.map((repoRoot) => ({ repoRoot })),
    normalizeRepoFilter(value, { ...context, cwd }),
  ).map((event) => event.repoRoot);
}

describe('--repo on Windows', () => {
  it('resolves relative and home values against a drive-letter working directory', () => {
    expect(normalizeRepoFilter(['.', '..\\notes', '~', '~\\notes'], context)).toEqual([
      { kind: 'path', input: '.', path: 'C:/Users/dev/work' },
      { kind: 'path', input: '..\\notes', path: 'C:/Users/dev/notes' },
      { kind: 'path', input: '~', path: 'C:/Users/dev' },
      { kind: 'path', input: '~\\notes', path: 'C:/Users/dev/notes' },
    ]);
  });

  it('selects the roots under a resolved value, with either separator and drive case', () => {
    expect(select('.\\api')).toEqual([
      'C:\\Users\\dev\\work\\api',
      'C:\\Users\\dev\\work\\api\\src',
    ]);
    expect(select('./web')).toEqual(['c:\\Users\\dev\\work\\web\\']);
    expect(select('./api', 'c:\\Users\\dev\\work')).toEqual([
      'C:\\Users\\dev\\work\\api',
      'C:\\Users\\dev\\work\\api\\src',
    ]);
    expect(select('~/notes')).toEqual(['C:\\Users\\dev\\notes']);
  });

  it('resolves against a UNC working directory without reaching other roots', () => {
    expect(select('./api', '\\\\server\\share')).toEqual(['\\\\server\\share\\api']);
  });
});
