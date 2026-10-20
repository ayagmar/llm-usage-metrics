import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexSourceAdapter } from '../../../src/sources/codex/index.js';
import { collect, collectFile } from '../../../src/stream/collect.js';
import { fixturePath } from '../../helpers/fixtures.js';
import { canCountOpenFds, countOpenFds, waitForOpenFdCount } from '../../helpers/open-fds.js';
import { canonicalTmpdir } from '../../helpers/tmp.js';

// Every Codex fixture directory, forks and their parents included.
const FIXTURE_ROOTS = [
  fixturePath(import.meta.url, '../../fixtures/codex'),
  fixturePath(import.meta.url, '../../fixtures/codex-fork'),
  fixturePath(import.meta.url, '../../fixtures/codex-fork-parent'),
  fixturePath(import.meta.url, '../../fixtures-events/codex'),
  fixturePath(import.meta.url, '../../../../../tests/fixtures/e2e/codex'),
];

const ROLLOUT = 'rollout-2026-10-04T15-00-00-019a0000-0000-7000-8000-0000000000aa.jsonl';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(canonicalTmpdir(), 'codex-zst-'));
  tempDirs.push(dir);
  return dir;
}

async function writeCompressed(filePath: string, content: Buffer | string): Promise<string> {
  const compressedPath = `${filePath}.zst`;
  await mkdir(path.dirname(compressedPath), { recursive: true });
  await writeFile(compressedPath, zstdCompressSync(Buffer.from(content)));
  return compressedPath;
}

/** A rollout of `rowCount` token_count rows, over 1 MiB once decompressed. */
function largeRollout(rowCount: number): string {
  const rows = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-large-zst' } }),
    ...Array.from({ length: rowCount }, (_, index) =>
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 1, 14, 10, 0, index)).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
        },
        padding: 'x'.repeat(1000),
      }),
    ),
  ];
  return `${rows.join('\n')}\n`;
}

describe('CodexSourceAdapter over compressed rollouts', () => {
  it('discovers .jsonl.zst rollouts, and only the plain file while both exist', async () => {
    const root = await createTempDir();
    const plain = path.join(root, 'a.jsonl');
    await writeFile(plain, '{}\n');
    await writeCompressed(plain, '{}\n');
    const compressedOnly = await writeCompressed(path.join(root, 'b.jsonl'), '{}\n');
    const nested = path.join(root, 'nested', 'c.jsonl');
    await writeCompressed(nested, '{}\n');
    await writeFile(path.join(root, 'd.zst'), '');

    await expect(new CodexSourceAdapter({ dir: root }).discoverFiles()).resolves.toEqual([
      plain,
      compressedOnly,
      `${nested}.zst`,
    ]);
  });

  it('reads every fixture compressed exactly as it reads it plain', async () => {
    for (const fixtureRoot of FIXTURE_ROOTS) {
      const compressedRoot = await createTempDir();
      const plainAdapter = new CodexSourceAdapter({ dir: fixtureRoot });
      const compressedAdapter = new CodexSourceAdapter({ dir: compressedRoot });
      const plainFiles = await plainAdapter.discoverFiles();

      for (const plainFile of plainFiles) {
        const relativePath = path.relative(fixtureRoot, plainFile);
        await writeCompressed(path.join(compressedRoot, relativePath), await readFile(plainFile));
      }

      // Forks look up their parent among the compressed rollouts.
      for (const plainFile of plainFiles) {
        const compressedFile = `${path.join(compressedRoot, path.relative(fixtureRoot, plainFile))}.zst`;

        await expect(
          collect(compressedAdapter.readEvents(compressedFile)),
          plainFile,
        ).resolves.toEqual(await collect(plainAdapter.readEvents(plainFile)));
        await expect(collectFile(compressedAdapter, compressedFile), plainFile).resolves.toEqual(
          await collectFile(plainAdapter, plainFile),
        );
      }
    }
  });

  it('names a session without session_meta after its rollout, plain or compressed', async () => {
    const root = await createTempDir();
    const line = JSON.stringify({
      timestamp: '2026-10-04T15:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } },
      },
    });
    const compressedPath = await writeCompressed(path.join(root, ROLLOUT), `${line}\n`);

    const events = await collect(new CodexSourceAdapter({ dir: root }).read(compressedPath));

    expect(events.map((event) => event.sessionId)).toEqual([path.basename(ROLLOUT, '.jsonl')]);
  });

  it('reads a rollout larger than a decoded chunk', async () => {
    const root = await createTempDir();
    const compressedPath = await writeCompressed(path.join(root, ROLLOUT), largeRollout(3000));

    const events = await collect(new CodexSourceAdapter({ dir: root }).read(compressedPath));

    expect(events).toHaveLength(3000);
  });

  it('fails a truncated or corrupt compressed rollout instead of reading part of it', async () => {
    const root = await createTempDir();
    const compressed = zstdCompressSync(Buffer.from(largeRollout(3000)));
    const truncatedPath = path.join(root, 'truncated.jsonl.zst');
    const corruptPath = path.join(root, 'corrupt.jsonl.zst');
    const emptyPath = path.join(root, 'empty.jsonl.zst');
    await writeFile(truncatedPath, compressed.subarray(0, Math.floor(compressed.length / 2)));
    await writeFile(corruptPath, 'not zstd at all\n');
    await writeFile(emptyPath, '');
    const adapter = new CodexSourceAdapter({ dir: root });

    await expect(collectFile(adapter, truncatedPath)).rejects.toThrow();
    await expect(collectFile(adapter, corruptPath)).rejects.toThrow();
    await expect(collectFile(adapter, emptyPath)).rejects.toThrow();
  });

  it('fails a rollout of several zstd frames instead of reading only the first', async () => {
    const root = await createTempDir();
    const filePath = path.join(root, 'frames.jsonl.zst');
    const frame = zstdCompressSync(Buffer.from(largeRollout(10)));
    await writeFile(filePath, Buffer.concat([frame, frame]));

    await expect(collectFile(new CodexSourceAdapter({ dir: root }), filePath)).rejects.toThrow(
      /after its first frame/u,
    );
  });

  it.runIf(canCountOpenFds)('closes the file when the consumer stops early', async () => {
    const root = await createTempDir();
    const compressedPath = await writeCompressed(path.join(root, ROLLOUT), largeRollout(3000));
    const adapter = new CodexSourceAdapter({ dir: root });
    const before = countOpenFds();

    for await (const event of adapter.read(compressedPath)) {
      expect(event.sessionId).toBe('codex-large-zst');
      break;
    }

    await waitForOpenFdCount(before);
  });
});
