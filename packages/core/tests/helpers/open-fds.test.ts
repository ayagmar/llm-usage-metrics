import { open } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { fixturePath } from './fixtures.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from './open-fds.js';

describe.runIf(canCountOpenFds)('waitForOpenFdCount', () => {
  it('resolves once a closed handle is gone', async () => {
    const before = countOpenFds();
    const handle = await open(fixturePath(import.meta.url, 'open-fds.ts'));
    await handle.close();

    await expect(waitForOpenFdCount(before)).resolves.toBeUndefined();
  });

  it('fails on a planted leak', async () => {
    const before = countOpenFds();
    const leaked = await open(fixturePath(import.meta.url, 'open-fds.ts'));

    try {
      await expect(waitForOpenFdCount(before, 100)).rejects.toThrow(
        `Expected ${before} open fds, still ${before + 1} after 100 ms`,
      );
    } finally {
      await leaked.close();
    }
  });
});
