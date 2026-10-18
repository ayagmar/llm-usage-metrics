import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { collectFile, createSourceContext, type SourceAdapter } from '@ayagmar/agent-sessions';
import { createDefaultAdapters } from '@ayagmar/agent-sessions/registry';
import { describe, expect, it } from 'vitest';

import {
  collectFileForEventStore,
  getEventStoreFileFingerprint,
  getStoredSessionEventKinds,
} from '../../src/cli/parse/stored-session-events.js';

// Every fixture directory of the sources whose files the store keeps tool calls and
// messages for: the CLI e2e and tools fixtures, and the core read and readEvents fixtures.
const FIXTURE_DIRS: Record<'claude' | 'codex' | 'pi', readonly string[]> = {
  claude: [
    'tests/fixtures/e2e/claude',
    'tests/fixtures/tools/claude',
    'packages/core/tests/fixtures-events/claude',
  ],
  codex: [
    'tests/fixtures/e2e/codex',
    'tests/fixtures/e2e-large/codex',
    'tests/fixtures/tools/codex',
    'packages/core/tests/fixtures/codex',
    'packages/core/tests/fixtures-events/codex',
  ],
  pi: [
    'tests/fixtures/e2e/pi',
    'tests/fixtures/e2e-large/pi',
    'tests/fixtures/tools/pi',
    'packages/core/tests/fixtures/pi',
    'packages/core/tests/fixtures-events/pi',
  ],
};

function createAdapter(sourceId: string, dir: string): SourceAdapter {
  const [adapter] = createDefaultAdapters(
    { sourceIds: [sourceId], roots: new Map([[sourceId, [path.resolve(dir)]]]) },
    createSourceContext({ homeDir: path.resolve('tests/fixtures/missing-home'), env: {} }),
  );
  return adapter;
}

describe('collectFileForEventStore', () => {
  for (const [sourceId, dirs] of Object.entries(FIXTURE_DIRS)) {
    it(`reads ${sourceId} usage and skipped rows byte for byte as collectFile does`, async () => {
      let fileCount = 0;
      let sessionEventCount = 0;

      for (const dir of dirs) {
        const adapter = createAdapter(sourceId, dir);

        for (const filePath of await adapter.discoverFiles()) {
          const usageOnly = await collectFile(adapter, filePath);
          const { sessionEvents, readCursor, resumedReplacing, ...forStore } =
            await collectFileForEventStore(adapter, filePath, { cursor: {} });

          expect(JSON.stringify(forStore), filePath).toBe(JSON.stringify(usageOnly));
          expect(resumedReplacing).toBeUndefined();
          // claude and pi are read under a cursor, kept only when every line was read.
          const content = await readFile(filePath);
          expect(readCursor?.offset, filePath).toBe(
            sourceId !== 'codex' && content.at(-1) === 0x0a ? content.length : undefined,
          );
          expect(sessionEvents?.some((event) => 'text' in event || 'raw' in event)).toBe(false);
          fileCount += 1;
          sessionEventCount += sessionEvents?.length ?? 0;
        }
      }

      expect(fileCount).toBeGreaterThan(2);
      expect(sessionEventCount).toBeGreaterThan(0);
    });
  }

  it('reads a usage-only source with collectFile and keeps no other kinds', async () => {
    const adapter = createAdapter('gemini', 'tests/fixtures/e2e/gemini');
    const [filePath] = await adapter.discoverFiles();

    expect(getStoredSessionEventKinds(adapter)).toEqual([]);
    expect(await collectFileForEventStore(adapter, filePath)).toEqual(
      await collectFile(adapter, filePath),
    );
  });
});

describe('getEventStoreFileFingerprint', () => {
  it('adds the kinds the store keeps only for a source that declares them', async () => {
    const codex = createAdapter('codex', 'tests/fixtures/e2e/codex');
    const gemini = createAdapter('gemini', 'tests/fixtures/e2e/gemini');
    const [codexFile] = await codex.discoverFiles();
    const [geminiFile] = await gemini.discoverFiles();

    expect(await getEventStoreFileFingerprint(codex, codexFile)).toMatchObject({
      storedKinds: ['message', 'tool_call'],
    });
    expect(await getEventStoreFileFingerprint(gemini, geminiFile)).not.toHaveProperty(
      'storedKinds',
    );
    await expect(
      getEventStoreFileFingerprint(codex, path.resolve('tests/fixtures/missing.jsonl')),
    ).resolves.toBeUndefined();
  });
});
