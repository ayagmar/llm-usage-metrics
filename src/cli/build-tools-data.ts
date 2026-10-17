import { getEventSessionKey } from '@ayagmar/agent-sessions';

import {
  buildEventProjectLabels,
  toProjectKey,
  UNATTRIBUTED_PROJECT_LABEL,
} from '../aggregate/project-key.js';
import { LOCAL_MACHINE_NAME, type UsageEvent } from '../domain/usage-event.js';
import { pluralize } from '../render/format-number.js';
import {
  aggregateTools,
  countToolCallsOnce,
  type ToolRow,
  type ToolTotals,
} from '../tools/aggregate-tools.js';
import { getCurrentLocalDateKey } from '../utils/time-buckets.js';
import { resolveUserConfigForOptions } from './apply-user-config.js';
import { resolveRecentDaysWindow } from './build-blocks-data.js';
import { normalizeBuildUsageInputs } from './build-usage-data-inputs.js';
import { buildUsageDiagnostics } from './build-usage-data-diagnostics.js';
import { buildUsageEventDataset } from './build-usage-event-dataset.js';
import { limitRows, parseTopRowsOption } from './build-session-data.js';
import { readLiveSessionEvents } from './read-live-session-events.js';
import { measureRuntimeProfileStage } from './runtime-profile.js';
import type {
  BuildUsageDataDeps,
  ReportCommandOptions,
  ToolsCommandOptions,
  UsageDiagnostics,
} from './usage-data-contracts.js';

export const TOOLS_DEFAULT_LAST_DAYS = 7;
const DEFAULT_TOOLS_TOP = 20;

export const LIVE_TOOL_CALLS_NOTE =
  'Tool calls are read from session files on disk (claude, codex, pi): files that no longer exist and other machines are not counted.';

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
  const userConfigResolution = await resolveUserConfigForOptions(options, deps);
  const configuredOptions = userConfigResolution.options;
  // Validates the dates and the timezone before they are used here.
  const { timezone } = normalizeBuildUsageInputs(
    configuredOptions,
    userConfigResolution.cliOptions,
  );
  const today = getCurrentLocalDateKey(timezone, deps.now?.() ?? new Date());
  const window = resolveRecentDaysWindow(
    options,
    configuredOptions,
    today,
    TOOLS_DEFAULT_LAST_DAYS,
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
  const failedReads =
    live.failedFilePaths.length === 0
      ? []
      : [
          `Tool calls left out of ${pluralize(live.failedFilePaths.length, 'file')} that could not be read`,
        ];

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
    ...(window.isDefault && window.since !== undefined ? { defaultWindowSince: window.since } : {}),
  };
}
