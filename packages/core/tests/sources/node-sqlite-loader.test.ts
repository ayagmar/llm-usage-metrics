import { describe, expect, it } from 'vitest';

import { loadNodeSqliteModuleFromRequire } from '../../src/sources/sqlite/node-sqlite-loader.js';

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
