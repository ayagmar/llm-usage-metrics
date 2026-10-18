import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** Open fds are counted through `/proc/self/fd`, so fd tests run on Linux only. */
export const canCountOpenFds = process.platform === 'linux';

export function countOpenFds(): number {
  return readdirSync('/proc/self/fd').length;
}

/**
 * Polls until the process has `expected` open fds, and fails after `timeoutMs` with the
 * last count. Use it after breaking out of a read: `expected` is the count taken before.
 */
export async function waitForOpenFdCount(expected: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let actual = countOpenFds();

  while (actual !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(`Expected ${expected} open fds, still ${actual} after ${timeoutMs} ms`);
    }

    await sleep(10);
    actual = countOpenFds();
  }
}
