import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageReport } from '../../../src/cli/run-usage-report.js';
import { canonicalTmpdir } from '../../helpers/tmp.js';

// One Claude Haiku 5.5 request whose 150k-token prompt is over the 100k long-context
// threshold (KI-1).
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

describe('Claude request with a prompt above 100k tokens', () => {
  it('prices the whole request at the long-context rates', async () => {
    const report = JSON.parse(
      await buildUsageReport('monthly', {
        claudeDir: fixtureDir,
        source: 'claude',
        json: true,
        pricingOffline: true,
        timezone: 'UTC',
      }),
    ) as {
      data: {
        rowType: string;
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costUsd: number;
      }[];
    };
    const grandTotal = report.data.find((row) => row.rowType === 'grand_total');

    // The prompt counts cache reads and writes: 50k + 90k + 10k = 150k > 100k.
    expect(grandTotal).toMatchObject({
      inputTokens: 50_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 10_000,
    });
    // Bundled-snapshot rates above 100k tokens for claude-haiku-5-5, per 1M: $0.50 input,
    // $0.05 cache read, $0.625 cache write, $2.50 output. Base rates would give $0.00765.
    expect(grandTotal?.costUsd).toBeCloseTo(0.025 + 0.0045 + 0.00625 + 0.0025, 10);
  });
});
