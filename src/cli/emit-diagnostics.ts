import type { UsageDiagnostics, UsagePricingOrigin } from './usage-data-contracts.js';
import { logger } from '../utils/logger.js';

export type DiagnosticsLogger = Pick<typeof logger, 'info' | 'warn' | 'dim' | 'debug'>;

type SkippedRowsStat = UsageDiagnostics['skippedRows'][number];

/**
 * Skip reasons that are routine: rows that carry no usage by design (tool calls,
 * synthetic or non-model messages), and goose's `invalid_model_config`, which keeps the
 * event. Only `--verbose` lists them; any other reason means data could not be read
 * and is a warning.
 */
const EXPECTED_SKIP_REASONS: ReadonlySet<string> = new Set([
  'invalid_model_config',
  'missing_usage_signal',
  'no_token_usage',
  'synthetic_message',
  'non_gemini_message',
]);

/** Counted per file by the parse coordinator when a whole file fails to parse. */
const FILE_PARSE_FAILED_REASON = 'file_parse_failed';

const pricingLabels: Record<UsagePricingOrigin, string | undefined> = {
  'offline-cache': 'cached pricing (offline)',
  cache: 'cached pricing',
  network: 'fetched pricing',
  'bundled-snapshot': 'bundled pricing',
  none: undefined,
};

const integerFormatter = new Intl.NumberFormat('en-US');

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${integerFormatter.format(count)} ${count === 1 ? singular : plural}`;
}

function formatReasonCounts(reasons: SkippedRowsStat['reasons']): string {
  return (reasons ?? [])
    .filter((reasonStat) => reasonStat.count > 0)
    .map((reasonStat) => `${reasonStat.reason} ${integerFormatter.format(reasonStat.count)}`)
    .join(', ');
}

type SkippedRowsSplit = {
  count: number;
  entries: Array<{ source: string; count: number; reasons: SkippedRowsStat['reasons'] }>;
};

/**
 * Splits each source's skipped rows into routine skips and problems. Rows without a
 * reason breakdown count as problems, since nothing says they were routine.
 */
function splitSkippedRows(skippedRows: readonly SkippedRowsStat[]): {
  expected: SkippedRowsSplit;
  problems: SkippedRowsSplit;
  fileFailures: SkippedRowsSplit;
} {
  const expected: SkippedRowsSplit = { count: 0, entries: [] };
  const problems: SkippedRowsSplit = { count: 0, entries: [] };
  const fileFailures: SkippedRowsSplit = { count: 0, entries: [] };

  for (const entry of skippedRows) {
    const reasons = (entry.reasons ?? []).filter((reasonStat) => reasonStat.count > 0);
    const expectedReasons = reasons.filter((reasonStat) =>
      EXPECTED_SKIP_REASONS.has(reasonStat.reason),
    );
    const expectedCount = expectedReasons.reduce((sum, reasonStat) => sum + reasonStat.count, 0);
    const failedFileCount =
      reasons.find((reasonStat) => reasonStat.reason === FILE_PARSE_FAILED_REASON)?.count ?? 0;
    const problemCount = Math.max(0, entry.skippedRows - expectedCount - failedFileCount);

    if (failedFileCount > 0) {
      fileFailures.count += failedFileCount;
      fileFailures.entries.push({ source: entry.source, count: failedFileCount, reasons: [] });
    }

    if (expectedCount > 0) {
      expected.count += expectedCount;
      expected.entries.push({
        source: entry.source,
        count: expectedCount,
        reasons: expectedReasons,
      });
    }

    if (problemCount > 0) {
      problems.count += problemCount;
      problems.entries.push({
        source: entry.source,
        count: problemCount,
        reasons: reasons.filter(
          (reasonStat) =>
            !EXPECTED_SKIP_REASONS.has(reasonStat.reason) &&
            reasonStat.reason !== FILE_PARSE_FAILED_REASON,
        ),
      });
    }
  }

  return { expected, problems, fileFailures };
}

/**
 * A source whose files yield no events while every skipped row looks routine has most
 * likely changed its log format (renamed usage fields read as "no usage"), so it warns.
 */
function findSourcesWithOnlyRoutineSkips(
  diagnostics: UsageDiagnostics,
  expected: SkippedRowsSplit,
): string[] {
  return diagnostics.sessionStats
    .filter(
      (session) =>
        session.filesFound > 0 &&
        session.eventsParsed === 0 &&
        expected.entries.some((entry) => entry.source === session.source && entry.count > 0),
    )
    .map((session) => session.source);
}

function formatSkippedEntries(split: SkippedRowsSplit): string {
  return split.entries
    .map((entry) => {
      const reasonSummary = formatReasonCounts(entry.reasons);
      const count = integerFormatter.format(entry.count);
      return reasonSummary
        ? `${entry.source} ${count} (${reasonSummary})`
        : `${entry.source} ${count}`;
    })
    .join(', ');
}

function formatSummaryLine(diagnostics: UsageDiagnostics, totalFiles: number): string {
  const sourcesWithFiles = diagnostics.sessionStats
    .filter((session) => session.filesFound > 0)
    .sort((left, right) => right.filesFound - left.filesFound);
  // Event counts depend on the date window and file skipping, so the line counts files;
  // `--verbose` lists events per source.
  const parts = [
    `Scanned ${pluralize(totalFiles, 'file')} (${sourcesWithFiles
      .map((session) => `${session.source} ${integerFormatter.format(session.filesFound)}`)
      .join(', ')})`,
  ];
  const pricingLabel = pricingLabels[diagnostics.pricingOrigin];

  if (pricingLabel) {
    parts.push(pricingLabel);
  }

  return [...parts, ...formatSettingsParts(diagnostics)].join(' · ');
}

/** Config and env overrides can change what is discovered, so both lines name them. */
function formatSettingsParts(diagnostics: UsageDiagnostics): string[] {
  const parts: string[] = [];

  if (diagnostics.activeConfig && diagnostics.activeConfig.entries.length > 0) {
    parts.push(`config ${diagnostics.activeConfig.path}`);
  }

  if (diagnostics.activeEnvOverrides.length > 0) {
    parts.push(pluralize(diagnostics.activeEnvOverrides.length, 'env override'));
  }

  return parts;
}

/**
 * Report diagnostics on stderr: one summary line by default, warnings only for real
 * problems, and the per-source and skipped-row breakdowns under `--verbose` (debug).
 */
export function emitDiagnostics(
  diagnostics: UsageDiagnostics,
  diagnosticsLogger: DiagnosticsLogger = logger,
): void {
  const totalFiles = diagnostics.sessionStats.reduce((sum, session) => sum + session.filesFound, 0);

  if (totalFiles > 0) {
    diagnosticsLogger.info(formatSummaryLine(diagnostics, totalFiles));
  } else {
    const settings = formatSettingsParts(diagnostics);
    const settingsNote = settings.length > 0 ? ` (with ${settings.join(', ')})` : '';
    diagnosticsLogger.warn(
      `No session files found${settingsNote}. Run \`llm-usage doctor\` to see where each source is searched.`,
    );
  }

  for (const session of diagnostics.sessionStats) {
    diagnosticsLogger.debug(
      `${session.source}: ${pluralize(session.filesFound, 'file')}, ${pluralize(session.eventsParsed, 'event')}`,
    );
  }

  for (const failure of diagnostics.sourceFailures) {
    diagnosticsLogger.warn(`Failed to parse ${failure.source}: ${failure.reason}`);
  }

  const { expected, problems, fileFailures } = splitSkippedRows(diagnostics.skippedRows);

  if (fileFailures.count > 0) {
    diagnosticsLogger.warn(
      `Could not parse ${pluralize(fileFailures.count, 'file')}: ${formatSkippedEntries(fileFailures)}`,
    );
  }

  if (problems.count > 0) {
    diagnosticsLogger.warn(
      `Skipped ${pluralize(problems.count, 'unreadable row')}: ${formatSkippedEntries(problems)}`,
    );
  }

  for (const source of findSourcesWithOnlyRoutineSkips(diagnostics, expected)) {
    diagnosticsLogger.warn(
      `${source}: files were found but no usage was read; its log format may have changed (--verbose for details)`,
    );
  }

  if (expected.count > 0) {
    diagnosticsLogger.debug(
      `Skipped ${pluralize(expected.count, 'row')} without usage: ${formatSkippedEntries(expected)}`,
    );
  }

  if (diagnostics.pricingWarning) {
    diagnosticsLogger.warn(diagnostics.pricingWarning);
  }

  for (const warning of diagnostics.warnings ?? []) {
    diagnosticsLogger.warn(warning);
  }

  for (const note of diagnostics.notes ?? []) {
    diagnosticsLogger.info(note);
  }
}
