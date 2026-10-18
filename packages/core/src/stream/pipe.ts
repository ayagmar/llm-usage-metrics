/** One step of a pipeline: reads an async iterable and yields another. */
export type Stage<In, Out> = (source: AsyncIterable<In>) => AsyncIterable<Out>;

/** Runs `source` through `stages` from left to right. */
export function pipe<A>(source: AsyncIterable<A>): AsyncIterable<A>;
export function pipe<A, B>(source: AsyncIterable<A>, s1: Stage<A, B>): AsyncIterable<B>;
export function pipe<A, B, C>(
  source: AsyncIterable<A>,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
): AsyncIterable<C>;
export function pipe<A, B, C, D>(
  source: AsyncIterable<A>,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
): AsyncIterable<D>;
export function pipe<A, B, C, D, E>(
  source: AsyncIterable<A>,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
  s4: Stage<D, E>,
): AsyncIterable<E>;
export function pipe<A, B, C, D, E, F>(
  source: AsyncIterable<A>,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
  s4: Stage<D, E>,
  s5: Stage<E, F>,
): AsyncIterable<F>;
export function pipe<A, B, C, D, E, F, G>(
  source: AsyncIterable<A>,
  s1: Stage<A, B>,
  s2: Stage<B, C>,
  s3: Stage<C, D>,
  s4: Stage<D, E>,
  s5: Stage<E, F>,
  s6: Stage<F, G>,
): AsyncIterable<G>;
export function pipe(
  source: AsyncIterable<unknown>,
  ...stages: Stage<unknown, unknown>[]
): AsyncIterable<unknown> {
  return stages.reduce((current, stage) => stage(current), source);
}
