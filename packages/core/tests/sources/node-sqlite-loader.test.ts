import { describe, expect, it } from 'vitest';

import { AntigravitySourceAdapter } from '../../src/sources/antigravity/antigravity-source-adapter.js';
import { GooseSourceAdapter } from '../../src/sources/goose/goose-source-adapter.js';
import { OpenCodeSourceAdapter } from '../../src/sources/opencode/opencode-source-adapter.js';
import {
  loadNodeSqliteModule,
  loadNodeSqliteModuleFromRequire,
} from '../../src/sources/sqlite/node-sqlite-loader.js';
import { withSuppressedSqliteExperimentalWarning } from '../helpers/sqlite.js';

describe('loadNodeSqliteModuleFromRequire', () => {
  it('wraps loader failures with actionable runtime guidance', () => {
    expect(() =>
      loadNodeSqliteModuleFromRequire(() => {
        throw new Error('mock sqlite load failure');
      }),
    ).toThrow('SQLite source requires Node.js 22.16+ or 24+ runtime with node:sqlite support');
  });

  it('labels loader failures with the consumer that triggered them', () => {
    expect(() =>
      loadNodeSqliteModuleFromRequire(() => {
        throw new Error('mock sqlite load failure');
      }, 'Event store'),
    ).toThrow('Event store requires Node.js 22.16+ or 24+ runtime with node:sqlite support');
  });

  it('wraps invalid sqlite modules with actionable runtime guidance', () => {
    expect(() => loadNodeSqliteModuleFromRequire(() => ({ DatabaseSync: undefined }))).toThrow(
      'node:sqlite loaded but did not expose a DatabaseSync constructor',
    );
  });
});

describe('loadNodeSqliteModule', () => {
  it('loads a node:sqlite that can open and query a database', async () => {
    const sqlite = await withSuppressedSqliteExperimentalWarning(() =>
      loadNodeSqliteModule('Event store'),
    );
    const database = new sqlite.DatabaseSync(':memory:');

    try {
      expect(database.prepare('SELECT 1 + 1 AS total').all()).toEqual([{ total: 2 }]);
    } finally {
      database.close();
    }
  });
});

describe('SQLite adapters without node:sqlite', () => {
  const missingSqlite = (consumerLabel: string) =>
    Promise.resolve().then(() =>
      loadNodeSqliteModuleFromRequire(() => {
        throw new Error('No such built-in module: node:sqlite');
      }, consumerLabel),
    );
  const fileChecks = {
    pathExists: async () => true,
    pathReadable: async () => true,
    pathIsFile: async () => true,
    maxBusyRetries: 0,
  };

  it.each([
    ['OpenCode', new OpenCodeSourceAdapter({ ...fileChecks, loadSqliteModule: missingSqlite })],
    ['Goose', new GooseSourceAdapter({ ...fileChecks, loadSqliteModule: missingSqlite })],
    [
      'Antigravity',
      new AntigravitySourceAdapter({ ...fileChecks, loadSqliteModule: missingSqlite }),
    ],
  ])('names %s in the runtime error', async (sourceName, adapter) => {
    await expect(adapter.read('/missing/source.db').next()).rejects.toThrow(
      `${sourceName} requires Node.js 22.16+ or 24+ runtime with node:sqlite support`,
    );
  });
});
