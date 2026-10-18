import { describe, expect, it } from 'vitest';

import { collect } from '../../src/stream/collect.js';
import { pipe, type Stage } from '../../src/stream/pipe.js';

async function* numbers(...values: number[]): AsyncGenerator<number> {
  yield* values;
}

function map<In, Out>(transform: (value: In) => Out): Stage<In, Out> {
  return async function* (source) {
    for await (const value of source) {
      yield transform(value);
    }
  };
}

describe('pipe', () => {
  it('returns the source when given no stages', async () => {
    const source = numbers(1, 2);

    expect(pipe(source)).toBe(source);
  });

  it('runs the stages from left to right', async () => {
    const result = pipe(
      numbers(1, 2, 3),
      map((value: number) => value + 1),
      map((value: number) => value * 10),
      map((value: number) => `#${value}`),
    );

    expect(await collect(result)).toEqual(['#20', '#30', '#40']);
  });
});
