import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createReadDiagnostics, recordSkippedRow } from '../../src/sources/parse-diagnostics.js';
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

function createAdapter(read: SourceAdapter['read']): SourceAdapter {
  return { id: 'pi', discoverFiles: async () => [], read };
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
    const adapter = createAdapter(async function* (filePath, options) {
      const diagnostics = options?.diagnostics ?? createReadDiagnostics();
      recordSkippedRow(diagnostics, 'no_usage');
      yield createEvent(`${filePath}#1`);
      recordSkippedRow(diagnostics, 'bad_timestamp');
      recordSkippedRow(diagnostics, 'no_usage');
      yield createEvent(`${filePath}#2`);
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
    const adapter = createAdapter(async function* () {
      yield createEvent('partial');
      throw new Error('file is truncated');
    });

    await expect(collectFile(adapter, '/a.jsonl')).rejects.toThrow('file is truncated');
  });
});
