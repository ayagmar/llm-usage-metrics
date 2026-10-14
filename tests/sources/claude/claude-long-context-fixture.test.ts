import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageReport } from '../../../src/cli/run-usage-report.js';
import { canonicalTmpdir } from '../../helpers/tmp.js';

// Freezes v0.11.0 pricing of one Claude request above 200k input tokens (KI-1).
const fixtureDir = path.resolve('tests/fixtures/golden/claude/long-context');

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(canonicalTmpdir(), 'claude-long-context-fixture-'));
  vi.stubEnv('TZ', 'UTC');
  // Inline until M0-T1 merges; then use useBundledPricingOnly() from
  // tests/helpers/offline-pricing.ts and useIsolatedEnvironment() from
  // tests/helpers/isolated-env.ts.
  vi.stubEnv('XDG_CACHE_HOME', path.join(tempRoot, 'cache'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(tempRoot, 'missing-claude-config'));
  vi.stubGlobal('fetch', () => {
    throw new Error('fetch must not be called: pricing is the bundled snapshot');
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(tempRoot, { recursive: true, force: true });
});

describe('Claude request above 200k input tokens', () => {
  it('prices the whole request at the base input rate', async () => {
    const report = JSON.parse(
      await buildUsageReport('monthly', {
        claudeDir: fixtureDir,
        source: 'claude',
        json: true,
        pricingOffline: true,
        timezone: 'UTC',
      }),
    ) as { data: { rowType: string; inputTokens: number; costUsd: number }[] };
    const grandTotal = report.data.find((row) => row.rowType === 'grand_total');

    expect(grandTotal?.inputTokens).toBe(250_000);
    // KNOWN ISSUE KI-1: the >200k tier is not applied. 0.75 is 250k x $3/M, the base
    // claude-sonnet-4-5 input rate in the bundled snapshot.
    expect(grandTotal?.costUsd).toBe(0.75);
  });
});
