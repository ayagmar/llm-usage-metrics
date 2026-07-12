export type RunWithParseBudget = <T>(task: () => Promise<T>) => Promise<T>;

export function createParseBudget(maxParallelFileParsing: number): RunWithParseBudget {
  const safeMaxParallelFileParsing =
    Number.isFinite(maxParallelFileParsing) && maxParallelFileParsing > 0
      ? Math.max(1, Math.floor(maxParallelFileParsing))
      : 1;
  let availablePermits = safeMaxParallelFileParsing;
  const waitingResolvers: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (availablePermits > 0) {
      availablePermits -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      waitingResolvers.push(resolve);
    });
  }

  function release(): void {
    const nextResolver = waitingResolvers.shift();

    if (nextResolver) {
      nextResolver();
      return;
    }

    availablePermits += 1;
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();

    try {
      return await task();
    } finally {
      release();
    }
  };
}
