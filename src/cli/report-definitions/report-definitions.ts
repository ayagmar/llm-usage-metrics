import { Argument, Command, InvalidArgumentError, Option } from 'commander';

import type {
  BlocksCommandOptions,
  EventsCommandOptions,
  CompareCommandOptions,
  DoctorCommandOptions,
  EfficiencyCommandOptions,
  HourlyCommandOptions,
  OptimizeCommandOptions,
  PricingCommandOptions,
  ProjectsCommandOptions,
  PruneCommandOptions,
  ReportCommandOptions,
  SessionCommandOptions,
  StatuslineCommandOptions,
  SummaryCommandOptions,
  TrendsCommandOptions,
  ValueCommandOptions,
  WrappedCommandOptions,
} from '../usage-data-contracts.js';
import {
  DEFAULT_REPORT_WINDOWS,
  getReportPeriodName,
  HOURLY_MAX_LAST_DAYS,
} from '../build-usage-data.js';
import { runBlocksReport } from '../run-blocks-report.js';
import { runCompareReport } from '../run-compare-report.js';
import { runEfficiencyReport } from '../run-efficiency-report.js';
import { runHourlyReport } from '../run-hourly-report.js';
import { runOptimizeReport } from '../run-optimize-report.js';
import { runPricingReport } from '../run-pricing-report.js';
import { runProjectsReport } from '../run-projects-report.js';
import { runSessionReport } from '../run-session-report.js';
import { runSummaryReport } from '../run-summary-report.js';
import { runStatusline } from '../run-statusline.js';
import { runTrendsReport } from '../run-trends-report.js';
import { runUsageReport } from '../run-usage-report.js';
import { runDoctorReport } from '../run-doctor-report.js';
import { runPruneReport } from '../run-prune-report.js';
import { runEventsReport } from '../run-events-report.js';
import { runValueReport } from '../run-value-report.js';
import { runWrappedReport } from '../run-wrapped-report.js';
import { DEFAULT_PLAN_ID, FALLBACK_PLAN_ID, PLAN_IDS } from '../../value/plans.js';
import type { ReportGranularity } from '../../utils/time-buckets.js';
import {
  collectRepeatedOption,
  getAllowedSourcesLabel,
  getSupportedSourceIds,
  registerSharedReportOptions,
} from './shared-report-options.js';
import type {
  ReportDefinitionMeta,
  ReportHelpExample,
  ReportRuntimeDefinition,
} from './report-definition-types.js';

const reportReferenceExamples: readonly ReportHelpExample[] = [
  {
    command: 'npx --yes llm-usage-metrics@latest',
    includeInRootHelp: true,
  },
];

/** The `<granularity>` values of efficiency and optimize. */
export const GRANULARITY_ARGUMENT_VALUES = [
  'daily',
  'weekly',
  'monthly',
] as const satisfies readonly ReportGranularity[];

function parseGranularityArgument(value: string): ReportGranularity {
  const normalized = value.trim().toLowerCase();
  const granularity = GRANULARITY_ARGUMENT_VALUES.find((candidate) => candidate === normalized);

  if (granularity) {
    return granularity;
  }

  throw new Error(
    `Invalid granularity: ${value}. Expected one of: ${GRANULARITY_ARGUMENT_VALUES.join(', ')}`,
  );
}

function addGranularityArgument(command: Command): Command {
  // commander's own missing-argument error does not list the choices, so this overrides
  // commander's private, untyped `missingArgument`. The create-cli-dispatch test pins it;
  // check it when upgrading commander.
  const reportMissingGranularity = (name: string): never =>
    command.error(
      `error: missing required argument '${name}' (choose ${GRANULARITY_ARGUMENT_VALUES.join(', ')})`,
      { code: 'commander.missingArgument' },
    );

  return Object.assign(command, { missingArgument: reportMissingGranularity }).addArgument(
    new Argument('<granularity>', 'Report period')
      .choices(GRANULARITY_ARGUMENT_VALUES)
      // Must stay after .choices(), which installs a strict case-sensitive parser.
      .argParser(parseGranularityArgument),
  );
}

const REPO_FILTER_DESCRIPTION =
  'Count only these projects (repeatable or comma-separated, so a value cannot contain a comma). A path (absolute, or ./, ../, ~/ on this machine) matches that repository root and the roots under it; a name or path tail such as work/api matches the end of a root, not the roots under it; (unattributed) matches usage without a root. Applied after --model picks exact or substring matching';

function addRepoFilterOption(command: Command, note?: string): Command {
  return command.option(
    '--repo <project>',
    note === undefined ? REPO_FILTER_DESCRIPTION : `${REPO_FILTER_DESCRIPTION}. ${note}`,
    collectRepeatedOption,
  );
}

const USAGE_COMPACT_DESCRIPTION =
  'Abbreviate token counts and hide the Reasoning and Cache Write columns (terminal/markdown)';
const ROLLUP_COMPACT_DESCRIPTION =
  'Abbreviate token counts and leave out minor columns (terminal/markdown)';

/** `--compact` and `--no-cost`; the usage reports' wording unless told otherwise. */
function addTableDisplayOptions(
  command: Command,
  costTarget: string,
  compactDescription = USAGE_COMPACT_DESCRIPTION,
): Command {
  return command
    .option('--compact', compactDescription)
    .addOption(
      new Option('--no-cost', `Leave cost out of ${costTarget}, e.g. for screenshots`).conflicts(
        'costMode',
      ),
    );
}

const BY_MACHINE_DESCRIPTION = 'Split each source row by the machine its usage came from';
const BY_REPO_ROW_DESCRIPTION = 'Split each source row by project (repository root)';

const MAX_COMMAND_HELP_EXAMPLES = 4;

/** An `Examples:` block for `--help`, or nothing when there are no examples. */
export function formatHelpExamples(commands: readonly string[]): string {
  return commands.length === 0
    ? ''
    : ['', 'Examples:', ...commands.map((command) => `  $ ${command}`)].join('\n');
}

function createCommand(definition: ReportRuntimeDefinition): Command {
  const command = new Command(definition.meta.commandName);
  command.description(definition.meta.description);
  registerSharedReportOptions(command, definition.meta.sharedOptionProfile);
  // The shortest examples suit --help; the long path-flag ones stay in the CLI reference.
  const candidates = definition.meta.helpExamples
    .map((example) => example.command)
    .filter((example) => !example.endsWith(' --help'));
  const shortest = new Set(
    [...candidates]
      .sort((left, right) => left.length - right.length)
      .slice(0, MAX_COMMAND_HELP_EXAMPLES),
  );
  const examples = candidates.filter((example) => shortest.has(example));
  command.addHelpText('after', formatHelpExamples(examples));
  return definition.register(command);
}

function createUsageReportDefinition(granularity: ReportGranularity): ReportRuntimeDefinition {
  const helpExamplesByGranularity: Record<ReportGranularity, readonly ReportHelpExample[]> = {
    daily: [
      {
        command: 'llm-usage daily',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage daily --help',
        includeInRootHelp: true,
      },
      {
        command:
          'llm-usage daily --source-dir pi=/tmp/pi-sessions --source-dir gemini=/tmp/.gemini --source-dir droid=/tmp/droid-sessions --source-dir openclaw=/tmp/openclaw-agents',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command:
          'llm-usage daily --pi-dir /tmp/pi-sessions --gemini-dir /tmp/.gemini --droid-dir /tmp/droid-sessions',
        includeInRootHelp: true,
      },
      {
        command: 'llm-usage daily --json',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage daily --markdown',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage daily --compact',
        includeInCliReference: true,
      },
    ],
    weekly: [
      {
        command: 'llm-usage weekly --timezone Europe/Paris',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage weekly --all --json',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage weekly --last 1 --no-cost',
        includeInCliReference: true,
      },
    ],
    monthly: [
      {
        command: 'llm-usage monthly --since 2026-01-01 --until 2026-01-31 --source pi,codex --json',
        includeInRootHelp: true,
      },
      {
        command: 'llm-usage monthly --since 2026-01-01 --until 2026-01-31',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage monthly --source opencode --opencode-db /path/to/opencode.db --json',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage monthly --source gemini --gemini-dir /path/to/.gemini',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage monthly --no-history --pricing-offline',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage monthly --source droid --droid-dir /path/to/.factory/sessions',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage monthly --model claude --per-model-columns',
        includeInRootHelp: true,
      },
      {
        command: 'llm-usage monthly --share',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage monthly --last 3',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
    ],
  };

  const descriptionByGranularity: Record<ReportGranularity, string> = {
    daily: 'Show daily usage report (last 7 days unless --last, --since, --until, or --all)',
    weekly:
      'Show weekly usage report (week starts Monday; last 8 weeks unless --last, --since, --until, or --all)',
    monthly: 'Show monthly usage report',
  };

  return {
    meta: {
      commandName: granularity,
      docsLabel: granularity,
      kind: 'usage-granularity',
      description: descriptionByGranularity[granularity],
      sharedOptionProfile: 'usage',
      helpExamples: helpExamplesByGranularity[granularity],
    },
    register(command) {
      const defaultWindow = DEFAULT_REPORT_WINDOWS[granularity];

      if (defaultWindow) {
        const { period, periods } = defaultWindow;
        command.option(
          '--all',
          `Report every ${period} instead of the last ${String(periods)} ${period}s`,
        );
      }

      const period = getReportPeriodName(granularity);

      command.option('--last <n>', `Report the last N ${period}s, counting the current ${period}`);
      addTableDisplayOptions(command, 'the table and share report')
        .option('--by-machine', BY_MACHINE_DESCRIPTION)
        .option('--by-repo', BY_REPO_ROW_DESCRIPTION);
      addRepoFilterOption(command);

      command.action((options: ReportCommandOptions) => runUsageReport(granularity, options));

      return command;
    },
  };
}

export const SUMMARY_COMMAND_NAME = 'summary';

const summaryReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: SUMMARY_COMMAND_NAME,
    docsLabel: 'summary',
    kind: 'specialized',
    description:
      'Show cost and tokens for today, the last 7 days, and month to date, plus activity streaks (default command)',
    sharedOptionProfile: 'summary',
    helpExamples: [
      {
        command: 'llm-usage',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage summary --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    addRepoFilterOption(command).action((options: SummaryCommandOptions) =>
      runSummaryReport(options),
    );

    return command;
  },
};

const efficiencyReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'efficiency',
    docsLabel: 'efficiency <daily|weekly|monthly>',
    kind: 'specialized',
    description: 'Show efficiency report by correlating usage metrics with local Git outcomes',
    sharedOptionProfile: 'specialized',
    helpExamples: [
      {
        command: 'llm-usage efficiency weekly --repo-dir /path/to/repo --json',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage efficiency monthly --share',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    addGranularityArgument(command)
      .option('--repo-dir <path>', 'Path to repository for Git outcome metrics')
      .option('--include-merge-commits', 'Include merge commits in Git outcome metrics')
      .option('--by-source', 'Include per-source usage rows under each period');
    addRepoFilterOption(
      command,
      'It filters usage events; --repo-dir picks the Git repository for outcomes',
    ).action((granularity: ReportGranularity, options: EfficiencyCommandOptions) =>
      runEfficiencyReport(granularity, options),
    );

    return command;
  },
};

const compareReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'compare',
    docsLabel: 'compare',
    kind: 'specialized',
    description: 'Compare usage and cost between two date windows',
    sharedOptionProfile: 'compare',
    helpExamples: [
      {
        command: 'llm-usage compare',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command:
          'llm-usage compare --since 2026-06-01 --until 2026-06-30 --vs-since 2026-05-01 --vs-until 2026-05-31',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option('--vs-since <date>', 'Inclusive start date for the baseline comparison window')
      .option('--vs-until <date>', 'Inclusive end date for the baseline comparison window')
      .option('--by-repo', 'Also compare each project (repository root)');
    addRepoFilterOption(command).action((options: CompareCommandOptions) =>
      runCompareReport(options),
    );

    return command;
  },
};

const optimizeReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'optimize',
    docsLabel: 'optimize <daily|weekly|monthly>',
    kind: 'specialized',
    description: 'Show counterfactual pricing report for candidate model(s)',
    sharedOptionProfile: 'specialized',
    helpExamples: [
      {
        command:
          'llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --json',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command:
          'llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --share',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    addGranularityArgument(command)
      .option(
        '--candidate-model <name>',
        'Candidate model for counterfactual pricing (repeatable or comma-separated)',
        collectRepeatedOption,
      )
      .option('--top <n>', 'Show only the top N cheapest candidates (positive integer)');
    addRepoFilterOption(command).action(
      (granularity: ReportGranularity, options: OptimizeCommandOptions) =>
        runOptimizeReport(granularity, options),
    );

    return command;
  },
};

const trendsReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'trends',
    docsLabel: 'trends',
    kind: 'specialized',
    description: 'Show daily cost or token usage trends',
    sharedOptionProfile: 'trends',
    helpExamples: [
      {
        command: 'llm-usage trends',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage trends --metric tokens --last 7',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage trends --by-source --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option(
        '--last <n>',
        'Chart the last N local calendar days, counting today; defaults to 30 when no date flags are provided',
      )
      .addOption(new Option('--days <n>', 'Alias of --last').hideHelp())
      .option('--metric <name>', 'Trend metric: cost | tokens | active-hours', 'cost')
      .option(
        '--by-source',
        'Render one sparkline row per source instead of a single combined chart',
      )
      .option(
        '--by-repo',
        'Render one sparkline row per project (repository root); not with --by-source',
      );
    addRepoFilterOption(command).action((options: TrendsCommandOptions) =>
      runTrendsReport(options),
    );

    return command;
  },
};

const sessionReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'session',
    docsLabel: 'session',
    kind: 'specialized',
    description: 'Show usage grouped by conversation session',
    sharedOptionProfile: 'session',
    helpExamples: [
      {
        command: 'llm-usage session',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage session --top 5 --json',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage session --id 486c',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage session --by-repo --top 5',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage session --markdown',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option('--top <n>', 'Show only the top N rows by cost (default 20; 0 shows all)')
      .option(
        '--id <session-id>',
        'Show only sessions whose id contains the value (case-insensitive; repeatable or comma-separated)',
        collectRepeatedOption,
      )
      .option('--by-repo', 'Group usage by repository root instead of by session');
    addRepoFilterOption(command).action((options: SessionCommandOptions) =>
      runSessionReport(options),
    );

    return command;
  },
};

const wrappedReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'wrapped',
    docsLabel: 'wrapped',
    kind: 'specialized',
    description: 'Show a yearly usage recap with an optional share report',
    sharedOptionProfile: 'wrapped',
    helpExamples: [
      {
        command: 'llm-usage wrapped',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage wrapped --year 2026 --share',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage wrapped --year 2026 --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option('--year <YYYY>', 'Year to recap (2020-2100; defaults to current local year)')
      .action((options: WrappedCommandOptions) => runWrappedReport(options));

    return command;
  },
};

const doctorReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'doctor',
    docsLabel: 'doctor',
    kind: 'specialized',
    description:
      'Show where each source is searched, whether its usage is readable, and ledger health',
    sharedOptionProfile: 'doctor',
    helpExamples: [
      {
        command: 'llm-usage doctor',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage doctor --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command.action((options: DoctorCommandOptions) => runDoctorReport(options));

    return command;
  },
};

const pruneReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'prune',
    docsLabel: 'prune',
    kind: 'specialized',
    description: 'Preview or delete departed files from the local event store',
    sharedOptionProfile: 'doctor',
    helpExamples: [
      {
        command: 'llm-usage prune --suppressed',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage prune --departed-before 2026-01-01 --apply',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option('--suppressed', 'Select departed files that --history already suppresses')
      .option(
        '--departed-before <YYYY-MM-DD>',
        'Select departed files whose newest event timestamp is strictly before this UTC date',
      )
      .option('--apply', 'Delete selected departed files and vacuum the event store')
      .action((options: PruneCommandOptions) => runPruneReport(options));

    return command;
  },
};

const eventsReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'events',
    docsLabel: 'events',
    kind: 'specialized',
    description: 'Export normalized usage events as JSONL or CSV',
    sharedOptionProfile: 'events',
    helpExamples: [
      {
        command: 'llm-usage events --format jsonl > events.jsonl',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage events --format csv --since 2026-01-01',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command.option('--format <name>', 'Export format: jsonl | csv', 'jsonl');
    addRepoFilterOption(command).action((options: EventsCommandOptions) =>
      runEventsReport(options),
    );

    return command;
  },
};

const statuslineDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'statusline',
    docsLabel: 'statusline',
    kind: 'specialized',
    description:
      "Print one line with today's cost, your streak, and month to date, led by the session's cost and context use under Claude Code (for status bars; never fetches)",
    sharedOptionProfile: 'statusline',
    helpExamples: [
      {
        command: 'llm-usage statusline',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage statusline --source claude',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command.action((options: StatuslineCommandOptions) => runStatusline(options));

    return command;
  },
};

const hourlyReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'hourly',
    docsLabel: 'hourly',
    kind: 'usage-granularity',
    description: 'Show hourly usage report (today unless --last, --since, or --until)',
    sharedOptionProfile: 'hourly',
    helpExamples: [
      {
        command: 'llm-usage hourly',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage hourly --last 3 --json',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage hourly --since 2026-06-15 --until 2026-06-15 --by-repo',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command.option(
      '--last <n>',
      `Report the last N days hour by hour (1-${String(HOURLY_MAX_LAST_DAYS)}), counting today`,
    );
    addTableDisplayOptions(command, 'the table')
      .option('--by-machine', BY_MACHINE_DESCRIPTION)
      .option('--by-repo', BY_REPO_ROW_DESCRIPTION);
    addRepoFilterOption(command).action((options: HourlyCommandOptions) =>
      runHourlyReport(options),
    );

    return command;
  },
};

const projectsReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'projects',
    docsLabel: 'projects',
    kind: 'specialized',
    description:
      'Show cost, tokens, events, active days and top models per project (the working directory the tool recorded), costliest first (full history unless --last, --since, or --until)',
    sharedOptionProfile: 'rollup',
    helpExamples: [
      {
        command: 'llm-usage projects',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage projects --last 3 --top 10',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage projects --granularity monthly --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .addOption(
        new Option('--granularity <period>', 'Add rows per period and project').choices(
          GRANULARITY_ARGUMENT_VALUES,
        ),
      )
      .option('--top <n>', 'Show only the top N projects by cost (positive integer)')
      .option('--last <n>', 'Report the last N months, counting the current month')
      .option('--all', 'Report the full history (the default without date flags)');
    addTableDisplayOptions(command, 'the table', ROLLUP_COMPACT_DESCRIPTION);
    addRepoFilterOption(command).action((options: ProjectsCommandOptions) =>
      runProjectsReport(options),
    );

    return command;
  },
};

export const BLOCKS_DEFAULT_LAST_DAYS = 7;

const blocksReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'blocks',
    docsLabel: 'blocks',
    kind: 'specialized',
    description:
      'Show estimated 5-hour usage blocks per source, across machines, with the active block (last 7 days unless --last, --since, --until, or --all; only meaningful for subscription plans)',
    sharedOptionProfile: 'rollup',
    helpExamples: [
      {
        command: 'llm-usage blocks',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage blocks --source claude --last 1',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage blocks --all --top 5 --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option(
        '--top <n>',
        'Show only the top N blocks across sources by cost, or by tokens when a cost is incomplete or with --no-cost (positive integer)',
      )
      .option(
        '--last <n>',
        `Report the last N days, counting today (default ${String(BLOCKS_DEFAULT_LAST_DAYS)})`,
      )
      .option(
        '--all',
        `Report every block instead of the last ${String(BLOCKS_DEFAULT_LAST_DAYS)} days`,
      );
    addTableDisplayOptions(command, 'the table', ROLLUP_COMPACT_DESCRIPTION);
    addRepoFilterOption(command).action((options: BlocksCommandOptions) =>
      runBlocksReport(options),
    );

    return command;
  },
};

function collectPlanOption(value: string, previous?: string[]): string[] {
  const plan = value.trim();

  if (!PLAN_IDS.some((id) => id === plan)) {
    throw new InvalidArgumentError(`Allowed choices are ${PLAN_IDS.join(', ')}.`);
  }

  return [...(previous ?? []), plan];
}

const valueReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'value',
    docsLabel: 'value',
    kind: 'specialized',
    description:
      'Compare the API-priced cost of each month with subscription plan prices, per plan and project (full history unless --last, --since, or --until)',
    sharedOptionProfile: 'rollup',
    helpExamples: [
      {
        command: 'llm-usage value',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage value --plan claude-max-5x --plan chatgpt-plus',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage value --plan claude-pro --plan-price 18 --last 6 --json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .addOption(
        new Option(
          '--plan <id>',
          `Plan to compare with, over the sources it covers (repeatable; default ${DEFAULT_PLAN_ID}, or ${FALLBACK_PLAN_ID} when the source filter leaves out claude). Two plans that cover the same source each count its full cost`,
        )
          .choices(PLAN_IDS)
          // Must stay after .choices(), which installs a parser that keeps only the last value.
          .argParser(collectPlanOption),
      )
      .option(
        '--plan-price <usd>',
        "Monthly plan price in USD to use instead of the plan's list price (one plan only)",
      )
      .option('--last <n>', 'Report the last N months, counting the current month')
      .option('--all', 'Report every month since the first usage (the default without date flags)');
    addTableDisplayOptions(command, 'the table', ROLLUP_COMPACT_DESCRIPTION);
    addRepoFilterOption(command).action((options: ValueCommandOptions) => runValueReport(options));

    return command;
  },
};

const pricingReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'pricing',
    docsLabel: 'pricing <model...>',
    kind: 'specialized',
    description:
      'Explain how model names resolve to prices: the matched pricing key and rule, overrides, where the prices came from, rates per 1M tokens and tiers (never reads usage)',
    sharedOptionProfile: 'pricing',
    helpExamples: [
      {
        command: 'llm-usage pricing claude-sonnet-4-5',
        includeInRootHelp: true,
        includeInCliReference: true,
      },
      {
        command: 'llm-usage pricing gpt-5 gpt-5-codex --json',
        includeInCliReference: true,
      },
      {
        command: 'llm-usage pricing my-model --pricing-overrides ./overrides.json',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .argument('<model...>', 'Model names, as they appear in usage logs')
      .action((models: string[], options: PricingCommandOptions) =>
        runPricingReport(models, options),
      );

    return command;
  },
};

const reportDefinitions = [
  summaryReportDefinition,
  hourlyReportDefinition,
  createUsageReportDefinition('daily'),
  createUsageReportDefinition('weekly'),
  createUsageReportDefinition('monthly'),
  projectsReportDefinition,
  compareReportDefinition,
  efficiencyReportDefinition,
  optimizeReportDefinition,
  trendsReportDefinition,
  sessionReportDefinition,
  blocksReportDefinition,
  valueReportDefinition,
  wrappedReportDefinition,
  eventsReportDefinition,
  pricingReportDefinition,
  statuslineDefinition,
  doctorReportDefinition,
  pruneReportDefinition,
] as const satisfies readonly ReportRuntimeDefinition[];

function getReportRuntimeDefinitions(): ReportRuntimeDefinition[] {
  return [...reportDefinitions];
}

export function getReportDefinitionMetas(): ReportDefinitionMeta[] {
  return reportDefinitions.map((definition) => definition.meta);
}

function collectHelpExamples(
  predicate: (example: ReportHelpExample) => boolean,
  extraExamples: readonly ReportHelpExample[] = [],
): string[] {
  return [
    ...reportDefinitions.flatMap((definition) => definition.meta.helpExamples),
    ...extraExamples,
  ]
    .filter(predicate)
    .map((example) => example.command);
}

function getRootHelpExamples(): string[] {
  return collectHelpExamples(
    (example) => example.includeInRootHelp === true,
    reportReferenceExamples,
  );
}

export function getCliReferenceExamples(): string[] {
  return collectHelpExamples((example) => example.includeInCliReference === true);
}

export function createReportCommands(): Command[] {
  return getReportRuntimeDefinitions().map((definition) => createCommand(definition));
}

export function createRootDescription(): string {
  const supportedSourceIds = getSupportedSourceIds();
  const allowedSourcesLabel = getAllowedSourcesLabel(supportedSourceIds);

  return [
    'Aggregate local LLM usage metrics from supported local session sources',
    `Supported sources (${supportedSourceIds.length}): ${allowedSourcesLabel}`,
    '',
    'Run `llm-usage <command> --help` to see command options (e.g. --json, --source).',
    '',
    'Examples:',
    ...getRootHelpExamples().map((example) => `  $ ${example}`),
  ].join('\n');
}
