/** Deps that may carry an injected clock: tests pass a fixed one, a run uses the system's. */
export type ClockDeps = { now?: () => Date };

/** The current time from the injected clock, or the system clock without one. */
export function readNow(deps: ClockDeps): Date {
  return deps.now?.() ?? new Date();
}

/**
 * Reads the clock once for a run, so its windows, dataset, machine notes and share page all
 * agree on the time, even across midnight. Deps already passed through keep their instant.
 */
export function withRunClock<Deps extends ClockDeps>(deps: Deps): Deps & { now: () => Date } {
  const nowMs = readNow(deps).getTime();

  return { ...deps, now: () => new Date(nowMs) };
}
