import { dedupeToolCalls, getEventSessionKey } from '@ayagmar/agent-sessions';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

import type { UsageEvent } from '../domain/usage-event.js';
import { buildOtlpMetrics } from '../otel-export/otlp-metrics.js';
import {
  formatOtlpPushSummary,
  OTLP_HEADERS_ENV_VAR,
  parseOtlpEndpoint,
  parseOtlpHeaders,
  pushOtlp,
  type OtlpPushDeps,
  type OtlpPushSignal,
} from '../otel-export/otlp-push.js';
import { buildOtlpTraces } from '../otel-export/otlp-traces.js';
import { logger } from '../utils/logger.js';
import { LIVE_TOOL_CALLS_NOTE } from './build-tools-data.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import {
  applyPricingToUsageEventDataset,
  buildUsageEventDataset,
} from './build-usage-event-dataset.js';
import { emitDiagnostics } from './emit-diagnostics.js';
import { formatFailedLiveReads, readLiveSessionEvents } from './read-live-session-events.js';
import { emitReportRunDiagnostics } from './report-runtime/report-lifecycle.js';
import type { BuildUsageDataDeps, EventsCommandOptions } from './usage-data-contracts.js';

const eventsExportFormats = ['jsonl', 'csv', 'otlp-traces', 'otlp-metrics'] as const;
type EventsExportFormat = (typeof eventsExportFormats)[number];

// Column order is frozen: fields present at the first release follow the
// UsageEvent declaration order, and newer fields append LAST, never reorder.
const CSV_HEADER =
  'source,sessionId,timestamp,repoRoot,provider,model,inputTokens,outputTokens,reasoningTokens,cacheReadTokens,cacheWriteTokens,totalTokens,costUsd,costMode,machine,cacheWrite1hTokens';

function resolveEventsFormat(options: EventsCommandOptions): EventsExportFormat {
  const format = options.format ?? 'jsonl';
  const resolved = eventsExportFormats.find((candidate) => candidate === format);

  if (!resolved) {
    throw new Error(`--format must be one of: ${eventsExportFormats.join(', ')}`);
  }

  if (options.otelIncludePaths && resolved !== 'otlp-traces') {
    throw new Error('--otel-include-paths needs --format otlp-traces');
  }

  if (
    options.otlpEndpoint !== undefined &&
    resolved !== 'otlp-traces' &&
    resolved !== 'otlp-metrics'
  ) {
    throw new Error('--otlp-endpoint needs --format otlp-traces or --format otlp-metrics');
  }

  return resolved;
}

type OtlpPushTarget = { endpoint: URL; headers: Record<string, string> };

function resolveOtlpPushTarget(options: EventsCommandOptions): OtlpPushTarget | undefined {
  if (options.otlpEndpoint === undefined) {
    return undefined;
  }

  return {
    endpoint: parseOtlpEndpoint(options.otlpEndpoint),
    headers: parseOtlpHeaders(process.env[OTLP_HEADERS_ENV_VAR]),
  };
}

/** Prints the export lines, or with `--otlp-endpoint` pushes them and prints one stderr line. */
async function writeOtlp(
  signal: OtlpPushSignal,
  pushTarget: OtlpPushTarget | undefined,
  deps: OtlpPushDeps,
): Promise<void> {
  if (pushTarget) {
    const result = await pushOtlp(pushTarget.endpoint, signal, pushTarget.headers, deps);
    logger.info(formatOtlpPushSummary(result));
    return;
  }

  for (const data of signal.lines) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  }
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
    event.machine,
    event.cacheWrite1hTokens,
  ]
    .map(toCsvField)
    .join(',');
}

export async function runEventsReport(
  options: EventsCommandOptions,
  deps: BuildUsageDataDeps & OtlpPushDeps = {},
): Promise<void> {
  const format = resolveEventsFormat(options);
  const pushTarget = resolveOtlpPushTarget(options);
  const dataset = await buildUsageEventDataset(options, deps);
  const { pricedEvents, pricingOrigin, pricingWarning } = await applyPricingToUsageEventDataset(
    dataset,
    deps,
    'auto',
  );
  const sortedEvents = sortEventsForExport(pricedEvents);
  // Tool spans and durations: the calls of the exported sessions, counted once as `tools`
  // counts them.
  const toolCalls =
    format === 'otlp-traces' || format === 'otlp-metrics'
      ? await readLiveSessionEvents(dataset, {
          kinds: ['tool_call'],
          sessionKeys: new Set(sortedEvents.map((event) => getEventSessionKey(event))),
        })
      : undefined;
  const diagnostics = buildUsageDiagnostics({
    adaptersToParse: dataset.adaptersToParse,
    successfulParseResults: dataset.successfulParseResults,
    sourceFailures: dataset.sourceFailures,
    pricingOrigin,
    pricingWarning,
    warnings: toolCalls
      ? [...dataset.warnings, ...formatFailedLiveReads('Tool calls', toolCalls.failedFilePaths)]
      : dataset.warnings,
    notes: toolCalls ? [...dataset.notes, LIVE_TOOL_CALLS_NOTE] : dataset.notes,
    activeEnvOverrides: dataset.readEnvVarOverrides(),
    activeConfig: dataset.activeConfig,
    timezone: dataset.normalizedInputs.timezone,
  });

  emitReportRunDiagnostics(diagnostics, {
    emitCommonDiagnostics: emitDiagnostics,
    getEnvVarOverrides: (usageDiagnostics) => usageDiagnostics.activeEnvOverrides,
    getActiveConfig: (usageDiagnostics) => usageDiagnostics.activeConfig,
  });

  if (toolCalls && format === 'otlp-metrics') {
    const lines = buildOtlpMetrics({
      usageEvents: sortedEvents,
      toolCalls: dedupeToolCalls(toolCalls.events),
      timezone: dataset.normalizedInputs.timezone,
    });
    await writeOtlp({ kind: 'metrics', lines }, pushTarget, deps);
    return;
  }

  if (toolCalls) {
    const lines = buildOtlpTraces({
      usageEvents: sortedEvents,
      toolCalls: dedupeToolCalls(toolCalls.events),
      includePaths: options.otelIncludePaths,
    });
    await writeOtlp({ kind: 'traces', lines }, pushTarget, deps);
    return;
  }

  if (format === 'csv') {
    process.stdout.write(`${CSV_HEADER}\n`);
  }

  for (const event of sortedEvents) {
    const line = format === 'jsonl' ? JSON.stringify(event) : toCsvLine(event);
    process.stdout.write(`${line}\n`);
  }
}
