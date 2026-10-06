import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addStoredFilesStillOnDisk } from '../../src/cli/history-live-files.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  closeEventStore,
  openEventStore,
  replaceFileEvents,
} from '../../src/persistence/event-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createErrnoError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('addStoredFilesStillOnDisk', () => {
  it('keeps present files live and applies the policy to unverifiable files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'history-live-files-'));
    tempDirs.push(tempDir);
    const store = await openEventStore(path.join(tempDir, 'events.db'));
    const filePaths = [
      '/stored/discovered',
      '/stored/present',
      '/stored/missing',
      '/stored/denied',
    ];

    try {
      for (const filePath of filePaths) {
        replaceFileEvents(store, {
          source: 'codex',
          filePath,
          fingerprint: { dependencies: [{ path: filePath, exists: true, size: 1, mtimeMs: 1 }] },
          events: [
            createUsageEvent({
              source: 'codex',
              sessionId: filePath,
              timestamp: '2026-02-01T00:00:00.000Z',
              inputTokens: 1,
            }),
          ],
          skippedRows: 0,
          now: 1,
        });
      }

      const statFile = async (filePath: string) => {
        if (filePath === '/stored/missing') {
          throw createErrnoError('ENOENT');
        }

        if (filePath === '/stored/denied') {
          throw createErrnoError('EACCES');
        }

        return {};
      };
      const input = {
        selectedSources: ['codex'],
        discoveredFiles: [{ source: 'codex', filePath: '/stored/discovered' }],
      };
      const liveFilePaths = async (unverifiable: 'treat-as-departed' | 'treat-as-live') =>
        (
          await addStoredFilesStillOnDisk(store, input, { unverifiable, statFile })
        ).discoveredFiles.map((file) => file.filePath);

      // History never hides usage it cannot prove is still on disk.
      expect(await liveFilePaths('treat-as-departed')).toEqual([
        '/stored/discovered',
        '/stored/present',
      ]);
      // Prune never deletes files it cannot prove are gone.
      expect(await liveFilePaths('treat-as-live')).toEqual([
        '/stored/discovered',
        '/stored/denied',
        '/stored/present',
      ]);
    } finally {
      closeEventStore(store);
    }
  });
});
