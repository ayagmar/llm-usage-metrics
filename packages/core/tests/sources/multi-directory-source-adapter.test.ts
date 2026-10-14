import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { MultiDirectorySourceAdapter } from '../../src/sources/multi-directory-source-adapter.js';
import { recordSkippedRow } from '../../src/sources/parse-diagnostics.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { collect, collectFile } from '../../src/stream/collect.js';

function createEvent(sessionId: string) {
  return createUsageEvent({
    source: 'pi',
    sessionId,
    timestamp: '2026-02-14T10:00:00.000Z',
    inputTokens: 1,
    outputTokens: 1,
  });
}

function createAdapter(
  files: string[],
  extras: Partial<SourceAdapter> = {},
): SourceAdapter & { parsed: string[] } {
  const parsed: string[] = [];

  return {
    id: 'pi',
    parserVersion: 3,
    capabilities: { eventsPrecedeFileMtime: true },
    parsed,
    discoverFiles: async () => files,
    async *read(filePath: string) {
      parsed.push(filePath);
      yield createEvent(filePath);
    },
    ...extras,
  };
}

describe('MultiDirectorySourceAdapter', () => {
  it('reports one source and lists a file shared by two directories once', async () => {
    const first = createAdapter(['/a/one.jsonl', '/shared/two.jsonl']);
    const second = createAdapter(['/shared/two.jsonl', '/b/three.jsonl']);
    const adapter = new MultiDirectorySourceAdapter([first, second]);

    expect(adapter.id).toBe('pi');
    expect(adapter.parserVersion).toBe(3);
    expect(adapter.capabilities).toEqual({ eventsPrecedeFileMtime: true });
    await expect(adapter.discoverFiles()).resolves.toEqual([
      '/a/one.jsonl',
      '/shared/two.jsonl',
      '/b/three.jsonl',
    ]);
  });

  it('reads each file through the adapter that discovered it', async () => {
    const first = createAdapter(['/a/one.jsonl']);
    const second = createAdapter(['/b/two.jsonl'], {
      async *read(filePath, options) {
        if (options?.diagnostics) {
          recordSkippedRow(options.diagnostics, 'no_usage');
          recordSkippedRow(options.diagnostics, 'bad_timestamp');
        }

        yield createEvent(`${filePath}#1`);
        yield createEvent(`${filePath}#2`);
      },
      getParseDependencies: async (filePath) => [`${filePath}.meta`],
    });
    const adapter = new MultiDirectorySourceAdapter([first, second]);
    await adapter.discoverFiles();

    await expect(collectFile(adapter, '/a/one.jsonl')).resolves.toEqual({
      events: [createEvent('/a/one.jsonl')],
      skippedRows: 0,
      skippedRowReasons: [],
    });
    await expect(collectFile(adapter, '/b/two.jsonl')).resolves.toEqual({
      events: [createEvent('/b/two.jsonl#1'), createEvent('/b/two.jsonl#2')],
      skippedRows: 2,
      skippedRowReasons: [
        { reason: 'bad_timestamp', count: 1 },
        { reason: 'no_usage', count: 1 },
      ],
    });
    await expect(collect(adapter.read('/b/two.jsonl'))).resolves.toHaveLength(2);
    expect(first.parsed).toEqual(['/a/one.jsonl']);
    expect(second.parsed).toEqual([]);
    await expect(adapter.getParseDependencies('/a/one.jsonl')).resolves.toEqual([]);
    await expect(adapter.getParseDependencies('/b/two.jsonl')).resolves.toEqual([
      '/b/two.jsonl.meta',
    ]);
  });

  it("returns the inner adapter's read when the consumer stops early", async () => {
    let finished = false;
    const converted = createAdapter(['/a/one.jsonl'], {
      async *read(filePath) {
        try {
          yield createEvent(`${filePath}#1`);
          yield createEvent(`${filePath}#2`);
        } finally {
          finished = true;
        }
      },
    });
    const adapter = new MultiDirectorySourceAdapter([converted]);
    await adapter.discoverFiles();

    for await (const event of adapter.read('/a/one.jsonl')) {
      expect(event.sessionId).toBe('/a/one.jsonl#1');
      break;
    }

    expect(finished).toBe(true);
  });

  it('returns the current files on every discovery, not only the first', async () => {
    const files = ['/a/one.jsonl'];
    const first = createAdapter([]);
    first.discoverFiles = async () => [...files];
    const adapter = new MultiDirectorySourceAdapter([first, createAdapter(['/b/two.jsonl'])]);

    await expect(adapter.discoverFiles()).resolves.toEqual(['/a/one.jsonl', '/b/two.jsonl']);
    files.push('/a/new.jsonl');
    await expect(adapter.discoverFiles()).resolves.toEqual([
      '/a/one.jsonl',
      '/a/new.jsonl',
      '/b/two.jsonl',
    ]);
  });

  it('needs at least one adapter', () => {
    expect(() => new MultiDirectorySourceAdapter([])).toThrow('needs at least one adapter');
  });

  it('lists the search paths of every directory, skipping adapters without any', () => {
    const adapter = new MultiDirectorySourceAdapter([
      createAdapter([], { getSearchPaths: () => ['/a'] }),
      createAdapter([]),
      createAdapter([], { getSearchPaths: () => ['/b', '/c'] }),
    ]);

    expect(adapter.getSearchPaths()).toEqual(['/a', '/b', '/c']);
  });
});
