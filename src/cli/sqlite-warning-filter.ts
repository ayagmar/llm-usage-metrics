// Imported first by the CLI entry, so the filter is in place before any module can load
// `node:sqlite`. Parse workers run the same entry and install their own.

const sqliteExperimentalWarningText =
  'SQLite is an experimental feature and might change at any time';

const filterMarker = Symbol.for('llm-usage-metrics.sqliteWarningFilter');

type MarkedEmitWarning = typeof process.emitWarning & { [filterMarker]?: true };

function readWarningType(warning: unknown, firstArgument: unknown): string | undefined {
  if (typeof firstArgument === 'string') {
    return firstArgument;
  }

  if (
    typeof firstArgument === 'object' &&
    firstArgument !== null &&
    'type' in firstArgument &&
    typeof firstArgument.type === 'string'
  ) {
    return firstArgument.type;
  }

  return warning instanceof Error ? warning.name : undefined;
}

function isSqliteExperimentalWarning(warning: unknown, firstArgument: unknown): boolean {
  const message =
    warning instanceof Error ? warning.message : typeof warning === 'string' ? warning : '';

  return (
    readWarningType(warning, firstArgument) === 'ExperimentalWarning' &&
    message.includes(sqliteExperimentalWarningText)
  );
}

/** Drops Node's SQLite ExperimentalWarning and forwards every other warning unchanged. */
export function installSqliteWarningFilter(): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the caller's `this`
  const originalEmitWarning = process.emitWarning as MarkedEmitWarning;

  if (originalEmitWarning[filterMarker]) {
    return;
  }

  const filteredEmitWarning = function (this: unknown, ...args: unknown[]): void {
    if (isSqliteExperimentalWarning(args[0], args[1])) {
      return;
    }

    Reflect.apply(originalEmitWarning, this, args);
  } as MarkedEmitWarning;
  filteredEmitWarning[filterMarker] = true;

  process.emitWarning = filteredEmitWarning;
}

installSqliteWarningFilter();
