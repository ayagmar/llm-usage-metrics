import { describe, expect, it } from 'vitest';

import { asRecord } from '../src/utils/as-record.js';

describe('asRecord', () => {
  it('returns plain objects and rejects non-record values', () => {
    expect(asRecord({ key: 'value' })).toEqual({ key: 'value' });
    expect(asRecord(Object.create(null))).toEqual({});

    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
    expect(asRecord('text')).toBeUndefined();
    expect(asRecord(123)).toBeUndefined();
    expect(asRecord(['a'])).toBeUndefined();
  });
});
