import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isSqliteExperimentalWarning,
  withSuppressedSqliteExperimentalWarning,
} from '../../src/sources/opencode/sqlite-warning-suppression.js';

const sqliteExperimentalWarningText =
  'SQLite is an experimental feature and might change at any time';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isSqliteExperimentalWarning', () => {
  it('returns true for sqlite experimental warnings with explicit warning type', () => {
    expect(isSqliteExperimentalWarning(sqliteExperimentalWarningText, 'ExperimentalWarning')).toBe(
      true,
    );
  });

  it('returns true for sqlite experimental warning errors using fallback warning name', () => {
    const warning = new Error(sqliteExperimentalWarningText);
    warning.name = 'ExperimentalWarning';

    expect(isSqliteExperimentalWarning(warning, undefined)).toBe(true);
  });

  it('returns false for warnings that do not match sqlite experimental signature', () => {
    expect(isSqliteExperimentalWarning('some other warning', 'Warning')).toBe(false);
  });

  it('returns false for non-error warning values without a warning type', () => {
    expect(isSqliteExperimentalWarning({ message: sqliteExperimentalWarningText }, undefined)).toBe(
      false,
    );
  });
});

describe('withSuppressedSqliteExperimentalWarning', () => {
  it('suppresses sqlite warning while forwarding unrelated warnings', () => {
    const forwardedWarning = 'forward this warning';
    const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    const result = withSuppressedSqliteExperimentalWarning(() => {
      const sqliteWarning = new Error(sqliteExperimentalWarningText);
      sqliteWarning.name = 'ExperimentalWarning';

      process.emitWarning(sqliteWarning);
      process.emitWarning(forwardedWarning, 'Warning');
      return 'ok';
    });

    const seenWarnings = emitWarningSpy.mock.calls.map((call) => String(call[0]));

    expect(result).toBe('ok');
    expect(seenWarnings.includes(forwardedWarning)).toBe(true);
    expect(seenWarnings.some((message) => message.includes(sqliteExperimentalWarningText))).toBe(
      false,
    );
  });

  it('detects sqlite warning type from warning options objects', () => {
    const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    withSuppressedSqliteExperimentalWarning(() => {
      process.emitWarning(sqliteExperimentalWarningText, {
        type: 'ExperimentalWarning',
      });
    });

    expect(emitWarningSpy).not.toHaveBeenCalled();
  });
});
