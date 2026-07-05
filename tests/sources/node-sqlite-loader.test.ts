import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadNodeSqliteModuleFromRequire } from '../../src/sources/opencode/node-sqlite-loader.js';

const sqliteExperimentalWarningText =
  'SQLite is an experimental feature and might change at any time';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadNodeSqliteModuleFromRequire', () => {
  it('suppresses sqlite experimental warnings while forwarding unrelated warnings', () => {
    const forwardedWarning = 'forward this warning';
    const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    const sqliteModule = loadNodeSqliteModuleFromRequire((moduleId) => {
      expect(moduleId).toBe('node:sqlite');

      const sqliteWarning = new Error(sqliteExperimentalWarningText);
      sqliteWarning.name = 'ExperimentalWarning';

      process.emitWarning(sqliteWarning);
      process.emitWarning(forwardedWarning, 'Warning');

      return {
        DatabaseSync: class FakeDatabaseSync {
          public prepare(): never {
            throw new Error('not implemented');
          }

          public close(): void {
            // no-op
          }
        },
      };
    });

    const seenWarnings = emitWarningSpy.mock.calls.map((call) => String(call[0]));

    expect(typeof sqliteModule.DatabaseSync).toBe('function');
    expect(seenWarnings.includes(forwardedWarning)).toBe(true);
    expect(seenWarnings.some((message) => message.includes(sqliteExperimentalWarningText))).toBe(
      false,
    );
  });

  it('wraps loader failures with actionable runtime guidance', () => {
    expect(() =>
      loadNodeSqliteModuleFromRequire(() => {
        throw new Error('mock sqlite load failure');
      }),
    ).toThrow('OpenCode source requires Node.js 24+ runtime with node:sqlite support');
  });

  it('wraps invalid sqlite modules with actionable runtime guidance', () => {
    expect(() => loadNodeSqliteModuleFromRequire(() => ({ DatabaseSync: undefined }))).toThrow(
      'node:sqlite loaded but did not expose a DatabaseSync constructor',
    );
  });
});
