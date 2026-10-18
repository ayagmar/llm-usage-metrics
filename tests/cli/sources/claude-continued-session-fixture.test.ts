import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../../src/cli/build-usage-data.js';
import { buildUsageReport } from '../../../src/cli/run-usage-report.js';
import { collectFile } from '@ayagmar/agent-sessions';
import { ClaudeSourceAdapter } from '@ayagmar/agent-sessions/sources/claude';
import { canonicalTmpdir } from '../../helpers/tmp.js';

// Freezes v0.11.0 behaviour for a Claude session continued into a second file (KI-4).
const fixtureDir = path.resolve('tests/fixtures/golden/claude/continued-session');
const projectDir = path.join(fixtureDir, 'cont-project');
const reportOptions = {
  claudeDir: fixtureDir,
  source: 'claude',
  all: true,
  json: true,
  pricingOffline: true,
  timezone: 'UTC',
} as const;

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(canonicalTmpdir(), 'claude-continued-fixture-'));
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

describe('Claude session continued into a second file', () => {
  it('parses every row of each file on its own', async () => {
    const adapter = new ClaudeSourceAdapter({ dir: fixtureDir });

    const original = await collectFile(adapter, path.join(projectDir, 'session-a.jsonl'));
    const continued = await collectFile(adapter, path.join(projectDir, 'session-b.jsonl'));

    expect(original.skippedRows).toBe(0);
    expect(original.events.map((event) => event.sessionId)).toEqual(['cont-a', 'cont-a', 'cont-a']);
    // KI-4 not reproduced at the adapter level by design: each file is parsed on its own,
    // so the continued file keeps its 3 copied rows; the report collapses them.
    expect(continued.skippedRows).toBe(0);
    expect(continued.events).toHaveLength(5);
    expect(new Set(continued.events.map((event) => event.sessionId))).toEqual(new Set(['cont-b']));
  });

  it('counts the copied rows once in a report', async () => {
    const usageData = await buildUsageData('daily', reportOptions, {
      now: () => new Date('2026-06-21T12:00:00.000Z'),
    });
    const report = JSON.parse(await buildUsageReport('daily', reportOptions)) as {
      data: { rowType: string; totalTokens: number; costUsd: number }[];
    };
    const grandTotal = report.data.find((row) => row.rowType === 'grand_total');

    // KI-4 not reproduced at the report level: dedupeCopiedSessions keeps the
    // 3 copied rows once (cont-a starts first), so 3 + 2 new rows.
    expect(usageData.events).toHaveLength(5);
    expect(usageData.events.map((event) => event.sessionId)).toEqual([
      'cont-a',
      'cont-a',
      'cont-a',
      'cont-b',
      'cont-b',
    ]);
    expect(grandTotal?.totalTokens).toBe(1100);
    expect(grandTotal?.costUsd).toBe(0.0032085);
  });
});
