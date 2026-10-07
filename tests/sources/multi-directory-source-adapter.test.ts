import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { MultiDirectorySourceAdapter } from '../../src/sources/multi-directory-source-adapter.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

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
    parseFile: async (filePath: string) => {
      parsed.push(filePath);
      return [createEvent(filePath)];
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

  it('parses each file with the adapter that discovered it', async () => {
    const first = createAdapter(['/a/one.jsonl']);
    const second = createAdapter(['/b/two.jsonl'], {
      parseFileWithDiagnostics: async (filePath) => ({
        events: [createEvent(filePath)],
        skippedRows: 2,
      }),
      getParseDependencies: async (filePath) => [`${filePath}.meta`],
    });
    const adapter = new MultiDirectorySourceAdapter([first, second]);
    await adapter.discoverFiles();

    await adapter.parseFile('/a/one.jsonl');
    const firstDiagnostics = await adapter.parseFileWithDiagnostics('/a/one.jsonl');
    const secondDiagnostics = await adapter.parseFileWithDiagnostics('/b/two.jsonl');

    expect(first.parsed).toEqual(['/a/one.jsonl', '/a/one.jsonl']);
    expect(firstDiagnostics.skippedRows).toBe(0);
    expect(secondDiagnostics.skippedRows).toBe(2);
    await expect(adapter.getParseDependencies('/a/one.jsonl')).resolves.toEqual([]);
    await expect(adapter.getParseDependencies('/b/two.jsonl')).resolves.toEqual([
      '/b/two.jsonl.meta',
    ]);
  });

  it('needs at least one adapter', () => {
    expect(() => new MultiDirectorySourceAdapter([])).toThrow('needs at least one adapter');
  });
});
