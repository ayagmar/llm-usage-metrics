import { describe, expect, it } from 'vitest';

import { parseSourceDirectoryOverrides } from '../../src/utils/source-directory-overrides.js';

describe('source-directory-overrides', () => {
  it('parses normalized source directory overrides', () => {
    expect(parseSourceDirectoryOverrides([' PI = /tmp/pi ', 'codex=/tmp/codex'])).toEqual(
      new Map([
        ['pi', '/tmp/pi'],
        ['codex', '/tmp/codex'],
      ]),
    );
  });

  it('rejects empty values and duplicate source ids', () => {
    expect(() => parseSourceDirectoryOverrides(['pi=   '])).toThrow(
      '--source-dir must use non-empty <source-id>=<path> values',
    );
    expect(() => parseSourceDirectoryOverrides(['pi=/tmp/a', 'pi=/tmp/b'])).toThrow(
      'Duplicate --source-dir source id: pi',
    );
  });
});
