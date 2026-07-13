import { describe, expect, it } from 'vitest';

import { addUsd, roundUsd } from '../../src/utils/usd-math.js';

describe('usd-math', () => {
  it('adds the classic float case exactly', () => {
    expect(addUsd(0.1, 0.2)).toBe(0.3);
  });

  it('stays exact over a thousand tiny additions', () => {
    let total = 0;

    for (let index = 0; index < 1_000; index += 1) {
      total = addUsd(total, 0.000001);
    }

    expect(total).toBe(0.001);
  });

  it('rounds idempotently', () => {
    const rounded = roundUsd(1.0000000000004);

    expect(roundUsd(rounded)).toBe(rounded);
    expect(rounded).toBe(1);
  });
});
