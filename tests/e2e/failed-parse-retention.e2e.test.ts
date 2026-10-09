import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUsageData } from '../../src/cli/build-usage-data.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const sessionFixture = path.resolve('tests/fixtures/gemini/session-with-usage.json');
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function totalTokens(geminiDir: string): Promise<number | undefined> {
  const result = await buildUsageData('daily', {
    all: true,
    source: 'gemini',
    geminiDir,
    // A custom directory gets history only on request.
    history: true,
    timezone: 'UTC',
    pricingOffline: true,
  });

  return result.rows.find((row) => row.rowType === 'grand_total')?.totalTokens;
}

describe('a file that stops parsing', () => {
  it.each([
    ['incomplete JSON, as mid-rewrite', '{"sessionId": "session-001", "messages": ['],
    ['valid JSON of the wrong shape', 'null'],
  ])('keeps the events the ledger last read from it: %s', async (_, brokenContent) => {
    const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'failed-parse-retention-'));
    tempDirs.push(rootDir);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));

    const geminiDir = path.join(rootDir, 'gemini');
    const chatsDir = path.join(geminiDir, 'tmp', 'project', 'chats');
    const victimPath = path.join(chatsDir, 'victim.json');
    const session = await readFile(sessionFixture, 'utf8');
    await mkdir(chatsDir, { recursive: true });
    await writeFile(victimPath, session);
    // A second session keeps the source from failing as a whole once the victim breaks.
    await writeFile(
      path.join(chatsDir, 'other.json'),
      session.replace('"session-001"', '"session-002"'),
    );

    const before = await totalTokens(geminiDir);

    await writeFile(victimPath, brokenContent);
    await utimes(victimPath, new Date(), new Date(Date.now() + 60_000));
    const whileBroken = await totalTokens(geminiDir);

    await rm(victimPath);
    const afterDeparture = await totalTokens(geminiDir);

    expect(before).toBeGreaterThan(0);
    // The broken file counts nothing this run, and history then serves its last good events.
    expect(whileBroken).toBe((before ?? 0) / 2);
    expect(afterDeparture).toBe(before);
  });

  it('serves the history of a moved file while its new copy fails to parse', async () => {
    const rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'failed-parse-retention-'));
    tempDirs.push(rootDir);
    vi.stubEnv('LLM_USAGE_EVENT_STORE', '1');
    vi.stubEnv('LLM_USAGE_EVENT_STORE_PATH', path.join(rootDir, 'events.db'));

    const geminiDir = path.join(rootDir, 'gemini');
    const chatsDir = path.join(geminiDir, 'tmp', 'project', 'chats');
    const originalPath = path.join(chatsDir, 'original.json');
    const movedPath = path.join(chatsDir, 'moved.json');
    const session = await readFile(sessionFixture, 'utf8');
    await mkdir(chatsDir, { recursive: true });
    await writeFile(originalPath, session);
    await writeFile(
      path.join(chatsDir, 'other.json'),
      session.replace('"session-001"', '"session-002"'),
    );

    const before = await totalTokens(geminiDir);
    await rename(originalPath, movedPath);
    const afterMove = await totalTokens(geminiDir);

    // The moved copy's stored events are not counted while it fails, so they cannot
    // stand in for the original file's history.
    await writeFile(movedPath, 'null');
    await utimes(movedPath, new Date(), new Date(Date.now() + 60_000));
    const whileBroken = await totalTokens(geminiDir);

    expect(before).toBeGreaterThan(0);
    expect(afterMove).toBe(before);
    expect(whileBroken).toBe(before);
  });
});
