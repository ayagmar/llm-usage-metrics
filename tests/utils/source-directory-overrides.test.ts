import { describe, expect, it } from 'vitest';

import { toSourceDirectoryList } from '../../src/utils/source-directory-overrides.js';

describe('source-directory-overrides', () => {
  it('lists one or several directory values', () => {
    expect(toSourceDirectoryList(undefined)).toEqual([]);
    expect(toSourceDirectoryList('/tmp/a')).toEqual(['/tmp/a']);
    expect(toSourceDirectoryList(['/tmp/a', '/tmp/b'])).toEqual(['/tmp/a', '/tmp/b']);
  });
});
