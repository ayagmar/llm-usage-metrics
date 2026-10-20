import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const FIXTURE = path.resolve('packages/core/tests/fixtures/codex/session-token-usage-record.jsonl');
const ROLLOUT = 'rollout-2026-10-04T15-00-00-019a0000-0000-7000-8000-0000000000aa.jsonl';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

/** A rollout in a Codex home's sessions directory, read where Codex keeps it by default. */
async function createRollout(): Promise<{ plainPath: string; compressedPath: string }> {
  const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-zst-'));
  tempDirs.push(rootDir);
  const codexHome = path.join(rootDir, '.codex');
  vi.stubEnv('HOME', rootDir);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
  vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));

  const dayDir = path.join(codexHome, 'sessions', '2026', '10', '04');
  await mkdir(dayDir, { recursive: true });
  const plainPath = path.join(dayDir, ROLLOUT);
  await copyFile(FIXTURE, plainPath);

  return { plainPath, compressedPath: `${plainPath}.zst` };
}

async function compress(plainPath: string, compressedPath: string): Promise<void> {
  await writeFile(compressedPath, zstdCompressSync(await readFile(plainPath)));
}

async function daily(): Promise<{ total?: number; notes: string[] }> {
  const result = await buildUsageData('daily', {
    all: true,
    source: 'codex',
    timezone: 'UTC',
    pricingOffline: true,
  });

  return {
    total: result.rows.find((row) => row.rowType === 'grand_total')?.totalTokens,
    notes: result.diagnostics.notes ?? [],
  };
}

describe('daily over a Codex rollout that Codex compresses', () => {
  it('counts the session once before, during and after compression', async () => {
    const { plainPath, compressedPath } = await createRollout();
    const plain = await daily();

    // Codex publishes the compressed copy, then removes the plain file.
    await compress(plainPath, compressedPath);
    const both = await daily();
    await rm(plainPath);
    const compressed = await daily();

    expect(plain.total).toBeGreaterThan(0);
    expect(both.total).toBe(plain.total);
    expect(compressed.total).toBe(plain.total);
    // The departed plain file's stored events are the compressed file's: history serves none.
    expect(compressed.notes.join('\n')).not.toMatch(/History: included [1-9]/u);
  });

  it('counts the session once after Codex decompresses it to append to it', async () => {
    const { plainPath, compressedPath } = await createRollout();
    await compress(plainPath, compressedPath);
    await rm(plainPath);
    const compressed = await daily();

    await writeFile(plainPath, await readFile(FIXTURE));
    await rm(compressedPath);
    const plain = await daily();

    expect(compressed.total).toBeGreaterThan(0);
    expect(plain.total).toBe(compressed.total);
  });

  it('leaves out a damaged compressed rollout with a diagnostic and counts the rest', async () => {
    const { plainPath } = await createRollout();
    const plain = await daily();
    const compressed = zstdCompressSync(await readFile(FIXTURE));
    await writeFile(
      path.join(path.dirname(plainPath), 'rollout-damaged.jsonl.zst'),
      compressed.subarray(0, compressed.length - 8),
    );

    const result = await buildUsageData('daily', {
      all: true,
      source: 'codex',
      timezone: 'UTC',
      pricingOffline: true,
    });

    expect(result.rows.find((row) => row.rowType === 'grand_total')?.totalTokens).toBe(plain.total);
    expect(result.diagnostics.skippedRows[0]?.reasons).toContainEqual({
      reason: 'file_parse_failed',
      count: 1,
    });
  });
});
