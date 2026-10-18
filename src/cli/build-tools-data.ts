import { dedupeToolCalls } from '@ayagmar/agent-sessions';

import { buildEventProjectLabels, toProjectLabel } from '../aggregate/project-key.js';
import { mapSessionRepoRoots } from '../session/aggregate-sessions.js';
import { aggregateTools, type ToolRow, type ToolTotals } from '../tools/aggregate-tools.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { resolveUsageDataRequest } from './build-usage-data.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { buildUsageEventDataset } from './build-usage-event-dataset.js';
import { limitRows, parseTopRowsOption, resolveTopRowLimit } from './top-option.js';
import {
  formatFailedLiveReads,
  formatLiveEventsNote,
  readLiveSessionEvents,
} from './read-live-session-events.js';
import { measureRuntimeProfileStage } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  ToolsCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

/** A tool row with its projects labelled as `projects` labels them. */
export type ToolsReportRow = ToolRow & {
  /** With --by-repo. */
  project?: string;
  topProject: string;
};

export type ToolsReportData = {
  timezone: string;
  /** First day of the window (YYYY-MM-DD); null for the full history. */
  since: string | null;
  /** Last day of the window (YYYY-MM-DD); null when open-ended. */
  until: string | null;
  bySource: boolean;
  byRepo: boolean;
  /** Rows before --top. */
  rowCount: number;
  /** Most calls first; at most --top of them. */
  rows: ToolsReportRow[];
  totals: ToolTotals;
};

export type ToolsDataResult = {
  data: ToolsReportData;
  diagnostics: UsageDiagnostics;
  limitNote?: string;
  /** Set when no window flag was given, for the default-window hint. */
  defaultWindowSince?: string;
};

export async function buildToolsData(
  options: ToolsCommandOptions,
  deps: BuildUsageDataDeps = {},
): Promise<ToolsDataResult> {
  const top = parseTopRowsOption(options.top);
  // Without date flags, the last 7 days, as `daily` reports them.
  const windowRequest = await resolveUsageDataRequest('daily', options, deps);
  const userConfigResolution = await resolveUserConfigForOptions(
    windowRequest.options,
    windowRequest.deps,
  );
  const configuredOptions = userConfigResolution.options;
  const window = { since: configuredOptions.since, until: configuredOptions.until };
  // Validates the dates and the timezone before they are used here.
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const datasetOptions: ReportCommandOptions = {
    ...configuredOptions,
    since: window.since,
    until: window.until,
  };
  const dataset = await measureRuntimeProfileStage(deps.runtimeProfile, 'tools.dataset.total', () =>
    buildUsageEventDataset(datasetOptions, {
      ...deps,
      userConfigResolution: { ...userConfigResolution, options: datasetOptions },
    }),
  );
  const live = await measureRuntimeProfileStage(deps.runtimeProfile, 'tools.read_live', () =>
    readLiveSessionEvents(dataset, { kinds: ['tool_call'] }),
  );
  const { rows, totals } = aggregateTools(dedupeToolCalls(live.events), {
    sessionRepoRoots: mapSessionRepoRoots(dataset.filteredEvents),
    bySource: options.bySource,
    byRepo: options.byRepo,
  });
  const limited = limitRows(rows, resolveTopRowLimit(top), 'tools', 'calls');
  const projectLabels = buildEventProjectLabels(dataset.filteredEvents);
  const failedReads = formatFailedLiveReads('Tool calls', live.failedFilePaths);

  return {
    data: {
      timezone,
      since: window.since ?? null,
      until: window.until ?? null,
      bySource: options.bySource ?? false,
      byRepo: options.byRepo ?? false,
      rowCount: rows.length,
      rows: limited.rows.map((row) => ({
        ...row,
        ...(row.repoRoot === undefined
          ? {}
          : { project: toProjectLabel(row.repoRoot ?? undefined, projectLabels) }),
        topProject: toProjectLabel(row.topRepoRoot ?? undefined, projectLabels),
      })),
      totals,
    },
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin: 'none',
      warnings: [...dataset.warnings, ...failedReads],
      notes: [...dataset.notes, formatLiveEventsNote('Tool calls', dataset)],
      activeEnvOverrides: dataset.readEnvVarOverrides(),
      activeConfig: dataset.activeConfig,
      timezone,
      runtimeProfile: deps.runtimeProfile?.snapshot(),
    }),
    limitNote: limited.limitNote,
    ...(windowRequest.defaultWindowSince
      ? { defaultWindowSince: windowRequest.defaultWindowSince }
      : {}),
  };
}
