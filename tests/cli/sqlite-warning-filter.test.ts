import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSqliteWarningFilter } from '../../src/cli/sqlite-warning-filter.js';

const sqliteExperimentalWarningText =
  'SQLite is an experimental feature and might change at any time';

// eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto process as is
const emitWarningBeforeTest = process.emitWarning;
let originalEmitWarning: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalEmitWarning = vi.fn();
  process.emitWarning = originalEmitWarning as unknown as typeof process.emitWarning;
  installSqliteWarningFilter();
});

afterEach(() => {
  process.emitWarning = emitWarningBeforeTest;
});

describe('installSqliteWarningFilter', () => {
  it('drops the SQLite ExperimentalWarning in each form Node can emit it', () => {
    const warningError = new Error(sqliteExperimentalWarningText);
    warningError.name = 'ExperimentalWarning';

    process.emitWarning(sqliteExperimentalWarningText, 'ExperimentalWarning');
    process.emitWarning(sqliteExperimentalWarningText, { type: 'ExperimentalWarning' });
    process.emitWarning(warningError);

    expect(originalEmitWarning).not.toHaveBeenCalled();
  });

  it('forwards other warnings with identical arguments and receiver', () => {
    process.emitWarning('Buffer() is deprecated', {
      type: 'DeprecationWarning',
      code: 'DEP0005',
      detail: 'Use Buffer.from() instead.',
    });
    process.emitWarning('Some other feature is experimental', 'ExperimentalWarning');
    process.emitWarning(sqliteExperimentalWarningText, 'Warning');

    expect(originalEmitWarning.mock.calls).toEqual([
      [
        'Buffer() is deprecated',
        { type: 'DeprecationWarning', code: 'DEP0005', detail: 'Use Buffer.from() instead.' },
      ],
      ['Some other feature is experimental', 'ExperimentalWarning'],
      [sqliteExperimentalWarningText, 'Warning'],
    ]);
    expect(originalEmitWarning.mock.contexts).toEqual([process, process, process]);
  });

  it('installs once however many times it is called', () => {
    const filteredEmitWarning: unknown = Reflect.get(process, 'emitWarning');

    installSqliteWarningFilter();

    expect(Reflect.get(process, 'emitWarning')).toBe(filteredEmitWarning);
    process.emitWarning('forwarded once', 'Warning');
    expect(originalEmitWarning).toHaveBeenCalledTimes(1);
  });
});
