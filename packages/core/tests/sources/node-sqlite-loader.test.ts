import { describe, expect, it } from 'vitest';

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
    ).toThrow('OpenCode source requires Node.js 22.16+ or 24+ runtime with node:sqlite support');
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
