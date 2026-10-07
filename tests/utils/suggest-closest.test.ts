import { describe, expect, it } from 'vitest';

import { suggestClosest } from '../../src/utils/suggest-closest.js';

const commands = ['summary', 'daily', 'weekly', 'monthly', 'compare', 'session', 'doctor'];

describe('suggestClosest', () => {
  it('suggests the command a typo most likely meant', () => {
    expect(suggestClosest('dialy', commands)).toBe('daily');
    expect(suggestClosest('montly', commands)).toBe('monthly');
    expect(suggestClosest('DOCTOR', commands)).toBe('doctor');
    expect(suggestClosest('sesion', commands)).toBe('session');
  });

  it('suggests nothing for unrelated words', () => {
    expect(suggestClosest('xyzzy', commands)).toBeUndefined();
    expect(suggestClosest('foo', commands)).toBeUndefined();
    expect(suggestClosest('', commands)).toBeUndefined();
  });

  it('keeps the earlier candidate on ties', () => {
    expect(suggestClosest('ab', ['ax', 'xb'])).toBe('ax');
  });
});
