import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createReadDiagnostics, recordSkippedRow } from '../../src/sources/parse-diagnostics.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { collect, collectFile, readAdapterFile } from '../../src/stream/collect.js';

function createEvent(sessionId: string) {
  return createUsageEvent({
    source: 'pi',
    sessionId,
    timestamp: '2026-02-14T10:00:00.000Z',
    inputTokens: 1,
    outputTokens: 1,
  });
}

function createAdapter(extras: Partial<SourceAdapter>): SourceAdapter {
  return {
    id: 'pi',
    discoverFiles: async () => [],
    parseFile: async () => {
      throw new Error('parseFile must not be called');
    },
    ...extras,
  };
}

describe('collect', () => {
  it('returns every item in order', async () => {
    async function* numbers() {
      yield 1;
      yield 2;
      yield 3;
    }

    await expect(collect(numbers())).resolves.toEqual([1, 2, 3]);
  });
});

describe('collectFile', () => {
  it('returns the events a read yields with its skipped rows in code-point order', async () => {
    const adapter = createAdapter({
      async *read(filePath, options) {
        const diagnostics = options?.diagnostics ?? createReadDiagnostics();
        recordSkippedRow(diagnostics, 'no_usage');
        yield createEvent(`${filePath}#1`);
        recordSkippedRow(diagnostics, 'bad_timestamp');
        recordSkippedRow(diagnostics, 'no_usage');
        yield createEvent(`${filePath}#2`);
      },
    });

    await expect(collectFile(adapter, '/a.jsonl')).resolves.toEqual({
      events: [createEvent('/a.jsonl#1'), createEvent('/a.jsonl#2')],
      skippedRows: 3,
      skippedRowReasons: [
        { reason: 'bad_timestamp', count: 1 },
        { reason: 'no_usage', count: 2 },
      ],
    });
  });

  it('rejects with no events when the read throws after yielding', async () => {
    const adapter = createAdapter({
      async *read() {
        yield createEvent('partial');
        throw new Error('file is truncated');
      },
    });

    await expect(collectFile(adapter, '/a.jsonl')).rejects.toThrow('file is truncated');
  });

  it('returns the legacy diagnostics of an adapter without read unchanged', async () => {
    const unsorted = {
      events: [createEvent('/a.jsonl')],
      skippedRows: 3,
      skippedRowReasons: [
        { reason: 'no_usage', count: 2 },
        { reason: 'bad_timestamp', count: 1 },
      ],
    };
    const withoutReasons = { events: [], skippedRows: Number.NaN };

    await expect(
      collectFile(createAdapter({ parseFileWithDiagnostics: async () => unsorted }), '/a.jsonl'),
    ).resolves.toBe(unsorted);
    await expect(
      collectFile(
        createAdapter({ parseFileWithDiagnostics: async () => withoutReasons }),
        '/a.jsonl',
      ),
    ).resolves.toBe(withoutReasons);
  });

  it('reads an adapter with only parseFile as having no skipped rows', async () => {
    const adapter = createAdapter({ parseFile: async (filePath) => [createEvent(filePath)] });

    await expect(collectFile(adapter, '/a.jsonl')).resolves.toEqual({
      events: [createEvent('/a.jsonl')],
      skippedRows: 0,
      skippedRowReasons: [],
    });
  });
});

describe('readAdapterFile', () => {
  it("adds a legacy adapter's counts to the caller's diagnostics", async () => {
    const adapter = createAdapter({
      parseFileWithDiagnostics: async () => ({
        events: [],
        skippedRows: 2,
        skippedRowReasons: [{ reason: 'no_usage', count: 2 }],
      }),
    });
    const diagnostics = createReadDiagnostics();
    recordSkippedRow(diagnostics, 'no_usage');

    await collect(readAdapterFile(adapter, '/a.jsonl', { diagnostics }));
    await collect(readAdapterFile(adapter, '/b.jsonl'));

    expect(diagnostics).toEqual({
      skippedRows: 3,
      skippedRowReasons: new Map([['no_usage', 3]]),
    });
  });

  it('returns the adapter read when the consumer stops early', async () => {
    let finished = false;
    const adapter = createAdapter({
      async *read() {
        try {
          yield createEvent('first');
          yield createEvent('second');
        } finally {
          finished = true;
        }
      },
    });

    for await (const event of readAdapterFile(adapter, '/a.jsonl')) {
      expect(event.sessionId).toBe('first');
      break;
    }

    expect(finished).toBe(true);
  });
});
