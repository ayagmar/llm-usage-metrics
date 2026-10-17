import { getEventSessionKey } from '@ayagmar/agent-sessions';

import {
  buildEventProjectLabels,
  toProjectKey,
  UNATTRIBUTED_PROJECT_LABEL,
} from '../aggregate/project-key.js';
import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import {
  aggregateTools,
  countToolCallsOnce,
  type ToolRow,
  type ToolTotals,
} from '../tools/aggregate-tools.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { resolveUsageDataRequest } from './build-usage-data.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { buildUsageEventDataset } from './build-usage-event-dataset.js';
import { limitRows, parseTopRowsOption } from './build-session-data.js';
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

const DEFAULT_TOOLS_TOP = 20;

export const LIVE_TOOL_CALLS_NOTE = formatLiveEventsNote('Tool calls');

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

/** Each session's project key: the first repository root its usage logs. */
function mapSessionRepoRoots(events: readonly UsageEvent[]): Map<string, string | undefined> {
  const repoRoots = new Map<string, string | undefined>();

  for (const event of events) {
    const key = getEventSessionKey(event);

    if (repoRoots.get(key) === undefined) {
      repoRoots.set(key, toProjectKey(event.repoRoot));
    }
  }

  return repoRoots;
}

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
  // Tool calls are only in local files on disk: no history, no other machines, no sync.
  const datasetOptions: ReportCommandOptions = {
    ...configuredOptions,
    since: window.since,
    until: window.until,
    history: false,
    machine: [LOCAL_MACHINE_NAME],
    sync: false,
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
  const { rows, totals } = aggregateTools(countToolCallsOnce(live.events), {
    sessionRepoRoots: mapSessionRepoRoots(dataset.filteredEvents),
    bySource: options.bySource,
    byRepo: options.byRepo,
  });
  const limited = limitRows(
    rows,
    top === 0 ? undefined : (top ?? DEFAULT_TOOLS_TOP),
    'tools',
    'calls',
  );
  const projectLabels = buildEventProjectLabels(dataset.filteredEvents);
  const toProjectLabel = (repoRoot: string | null) =>
    projectLabels.get(repoRoot ?? undefined) ?? UNATTRIBUTED_PROJECT_LABEL;
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
        ...(row.repoRoot === undefined ? {} : { project: toProjectLabel(row.repoRoot) }),
        topProject: toProjectLabel(row.topRepoRoot),
      })),
      totals,
    },
    diagnostics: buildUsageDiagnostics({
      adaptersToParse: dataset.adaptersToParse,
      successfulParseResults: dataset.successfulParseResults,
      sourceFailures: dataset.sourceFailures,
      pricingOrigin: 'none',
      warnings: [...dataset.warnings, ...failedReads],
      notes: [...dataset.notes, LIVE_TOOL_CALLS_NOTE],
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
