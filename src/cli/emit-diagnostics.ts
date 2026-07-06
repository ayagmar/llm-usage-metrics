import type { UsageDiagnostics } from './usage-data-contracts.js';
import { logger } from '../utils/logger.js';

export type DiagnosticsLogger = Pick<typeof logger, 'info' | 'warn' | 'dim'>;

export function emitDiagnostics(
  diagnostics: UsageDiagnostics,
  diagnosticsLogger: DiagnosticsLogger = logger,
): void {
  const totalSessions = diagnostics.sessionStats.reduce(
    (sum, current) => sum + current.filesFound,
    0,
  );
  const totalEvents = diagnostics.sessionStats.reduce(
    (sum, current) => sum + current.eventsParsed,
    0,
  );

  if (totalSessions > 0) {
    diagnosticsLogger.info(`Found ${totalSessions} session file(s) with ${totalEvents} event(s)`);

    for (const session of diagnostics.sessionStats) {
      const eventsLabel = session.eventsParsed === 1 ? 'event' : 'events';
      diagnosticsLogger.dim(
        `  ${session.source}: ${session.filesFound} file(s), ${session.eventsParsed} ${eventsLabel}`,
      );
    }
  } else {
    diagnosticsLogger.warn('No sessions found');
  }

  if (diagnostics.sourceFailures.length > 0) {
    const sourceLabel = diagnostics.sourceFailures.length === 1 ? 'source' : 'sources';
    diagnosticsLogger.warn(`Failed to parse ${diagnostics.sourceFailures.length} ${sourceLabel}`);

    for (const failure of diagnostics.sourceFailures) {
      diagnosticsLogger.dim(`  ${failure.source}: ${failure.reason}`);
    }
  }

  const totalSkippedRows = diagnostics.skippedRows.reduce(
    (sum, skippedRowsEntry) => sum + skippedRowsEntry.skippedRows,
    0,
  );

  if (totalSkippedRows > 0) {
    const rowLabel = totalSkippedRows === 1 ? 'row' : 'rows';
    diagnosticsLogger.warn(`Skipped ${totalSkippedRows} malformed ${rowLabel}`);

    for (const skippedRowsEntry of diagnostics.skippedRows) {
      const reasonSummary = skippedRowsEntry.reasons
        ?.filter((reasonStat) => reasonStat.count > 0)
        .map((reasonStat) => `${reasonStat.reason}: ${reasonStat.count}`)
        .join(', ');

      diagnosticsLogger.dim(
        reasonSummary
          ? `  ${skippedRowsEntry.source}: ${skippedRowsEntry.skippedRows} skipped (${reasonSummary})`
          : `  ${skippedRowsEntry.source}: ${skippedRowsEntry.skippedRows} skipped`,
      );
    }
  }

  switch (diagnostics.pricingOrigin) {
    case 'offline-cache':
      diagnosticsLogger.info('Using cached pricing (offline mode)');
      break;
    case 'cache':
      diagnosticsLogger.info('Loaded pricing from cache');
      break;
    case 'network':
      diagnosticsLogger.info('Fetched pricing from LiteLLM');
      break;
    case 'none':
      break;
  }

  if (diagnostics.pricingWarning) {
    diagnosticsLogger.warn(diagnostics.pricingWarning);
  }

  for (const warning of diagnostics.warnings ?? []) {
    diagnosticsLogger.warn(warning);
  }
}
