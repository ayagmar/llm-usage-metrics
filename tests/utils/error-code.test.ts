import { describe, expect, it } from 'vitest';

import { hasErrorCode } from '../../src/utils/error-code.js';

function createErrnoError(code: string): Error {
  return Object.assign(new Error(`failed: ${code}`), { code });
}

describe('hasErrorCode', () => {
  it('matches only Node errors with one of the codes', () => {
    expect(hasErrorCode(createErrnoError('ENOENT'), 'ENOENT', 'ENOTDIR')).toBe(true);
    expect(hasErrorCode(createErrnoError('EACCES'), 'ENOENT')).toBe(false);
    expect(hasErrorCode(new Error('no code'), 'ENOENT')).toBe(false);
    expect(hasErrorCode('ENOENT', 'ENOENT')).toBe(false);
    expect(hasErrorCode({ code: 2 }, 'ENOENT')).toBe(false);
  });
});
