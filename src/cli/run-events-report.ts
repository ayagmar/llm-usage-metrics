import type { UsageEvent } from '../domain/usage-event.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import { logger } from '../utils/logger.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { emitActiveConfig } from './emit-active-config.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { emitEnvVarOverrides } from './emit-env-var-overrides.js';
import type { BuildUsageDataDeps, EventsCommandOptions } from './usage-data-contracts.js';

const eventsExportFormats = ['jsonl', 'csv'] as const;
type EventsExportFormat = (typeof eventsExportFormats)[number];

// Column order is the UsageEvent declaration order and is frozen: new fields
// append LAST, never reorder.
const CSV_HEADER =
  'source,sessionId,timestamp,repoRoot,provider,model,inputTokens,outputTokens,reasoningTokens,cacheReadTokens,cacheWriteTokens,totalTokens,costUsd,costMode';

function resolveEventsFormat(options: EventsCommandOptions): EventsExportFormat {
  if (options.json) {
    throw new Error('--json is not supported for events; use --format jsonl');
  }

  const format = options.format ?? 'jsonl';
  const resolved = eventsExportFormats.find((candidate) => candidate === format);

  if (!resolved) {
    throw new Error('--format must be one of: jsonl, csv');
  }

  return resolved;
}

function sortEventsForExport(events: readonly UsageEvent[]): UsageEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        compareByCodePoint(left.event.timestamp, right.event.timestamp) ||
        compareByCodePoint(left.event.source, right.event.source) ||
        compareByCodePoint(left.event.sessionId, right.event.sessionId) ||
        left.index - right.index,
    )
    .map(({ event }) => event);
}

function toCsvField(value: string | number | undefined): string {
  if (value === undefined) {
    return '';
  }

  // OWASP CSV-injection guidance: apostrophe-prefix cells that would start a
  // spreadsheet formula. Numbers are non-negative by normalization.
  const raw = String(value);
  const text = typeof value === 'string' && /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsvLine(event: UsageEvent): string {
  return [
    event.source,
    event.sessionId,
    event.timestamp,
    event.repoRoot,
    event.provider,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.reasoningTokens,
    event.cacheReadTokens,
    event.cacheWriteTokens,
    event.totalTokens,
    event.costUsd,
    event.costMode,
  ]
    .map(toCsvField)
    .join(',');
}

export async function runEventsReport(
  options: EventsCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<void> {
  const format = resolveEventsFormat(options);
  const dataset = await buildUsageEventDataset(options, deps);
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
  const sortedEvents = sortEventsForExport(pricedEvents);
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: dataset.warnings,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
  });

  emitDiagnostics(diagnostics);
  emitEnvVarOverrides(diagnostics.activeEnvOverrides, logger);
  emitActiveConfig(diagnostics.activeConfig, logger);

  if (format === 'csv') {
    process.stdout.write(`${CSV_HEADER}\n`);
  }

  for (const event of sortedEvents) {
    const line = format === 'jsonl' ? JSON.stringify(event) : toCsvLine(event);
    process.stdout.write(`${line}\n`);
  }
}
