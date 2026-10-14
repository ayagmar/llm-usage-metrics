import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, vi, type Mock } from 'vitest';

export type BundledPricingOnly = {
  /** The `fetch` stand-in; a test asserts it was never called. */
  readonly fetch: Mock<typeof fetch>;
};

/**
 * Makes every report in the calling test file price with the bundled snapshot: a fresh
 * empty `XDG_CACHE_HOME` (the vitest cache dir is shared by the whole run, so another
 * test's cached prices could leak in) and a `fetch` that throws. Reports still need
 * `pricingOffline: true` so they do not try the network first.
 */
export function useBundledPricingOnly(): BundledPricingOnly {
  const fetchStub = vi.fn<typeof fetch>(() => {
    throw new Error('network access is disabled in this test file');
  });
  let cacheDir: string | undefined;

  beforeAll(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-offline-pricing-'));
    vi.stubEnv('XDG_CACHE_HOME', cacheDir);
    vi.stubGlobal('fetch', fetchStub);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    if (cacheDir) {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  return { fetch: fetchStub };
}
