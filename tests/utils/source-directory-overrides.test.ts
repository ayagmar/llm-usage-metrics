import { describe, expect, it } from 'vitest';

import {
  parseSourceDirectoryOverrides,
  toSourceDirectoryList,
} from '../../src/utils/source-directory-overrides.js';

describe('source-directory-overrides', () => {
  it('parses normalized source directory overrides', () => {
    expect(parseSourceDirectoryOverrides([' PI = /tmp/pi ', 'codex=/tmp/codex'])).toEqual(
      new Map([
        ['pi', ['/tmp/pi']],
        ['codex', ['/tmp/codex']],
      ]),
    );
  });

  it('rejects empty values', () => {
    expect(() => parseSourceDirectoryOverrides(['pi=   '])).toThrow(
      '--source-dir must use non-empty <source-id>=<path> values',
    );
  });

  it('collects several directories per source, once each', () => {
    expect(parseSourceDirectoryOverrides(['pi=/tmp/a', 'pi=/tmp/b', 'pi=/tmp/a'])).toEqual(
      new Map([['pi', ['/tmp/a', '/tmp/b']]]),
    );
  });

  it('lists one or several directory values', () => {
    expect(toSourceDirectoryList(undefined)).toEqual([]);
    expect(toSourceDirectoryList('/tmp/a')).toEqual(['/tmp/a']);
    expect(toSourceDirectoryList(['/tmp/a', '/tmp/b'])).toEqual(['/tmp/a', '/tmp/b']);
  });
});
