import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const FORK_FIXTURES = path.resolve('packages/core/tests/fixtures/codex-fork');

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function dailyTotals(fixtureNames: readonly string[]): Promise<Record<string, number>> {
  const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-fork-'));
  tempDirs.push(rootDir);
  vi.stubEnv('HOME', rootDir);
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));

  const codexDir = path.join(rootDir, 'sessions');
  await mkdir(codexDir, { recursive: true });

  for (const name of fixtureNames) {
    await copyFile(path.join(FORK_FIXTURES, name), path.join(codexDir, name));
  }

  const result = await buildUsageData('daily', {
    all: true,
    source: 'codex',
    codexDir,
    timezone: 'UTC',
    pricingOffline: true,
  });
  const totals: Record<string, number> = {};

  for (const row of result.rows) {
    if (row.rowType === 'grand_total') {
      totals.all = row.totalTokens;
    } else {
      totals[row.periodKey] = row.totalTokens;
    }
  }

  return totals;
}

describe('daily over a Codex parent and its fork', () => {
  it('counts the parent once and the fork for its own turn only', async () => {
    const parent = await dailyTotals(['parent.jsonl']);
    const both = await dailyTotals(['parent.jsonl', 'fork-copied.jsonl']);

    expect(parent).toEqual({ '2026-01-01': 2760, all: 2760 });
    expect(both).toEqual({ '2026-01-01': 2760, '2026-01-02': 540, all: 3300 });
  });
});
