/** A random number in [0, 1), from a seeded generator so a failing run can be replayed. */
export type Random = () => number;

/** mulberry32: a small 32-bit PRNG, deterministic for a given seed. */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function randomInt(random: Random, maxExclusive: number): number {
  return Math.floor(random() * maxExclusive);
}

export function pick<T>(random: Random, items: readonly T[]): T {
  return items[randomInt(random, items.length)];
}

/** A Fisher-Yates shuffled copy; the input is left as it was. */
export function shuffle<T>(array: readonly T[], random: Random): T[] {
  const result = [...array];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(random, index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}
