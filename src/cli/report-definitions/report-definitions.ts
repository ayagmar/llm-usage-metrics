import { Command } from 'commander';

import type {
  DoctorCommandOptions,
  EfficiencyCommandOptions,
  OptimizeCommandOptions,
  ReportCommandOptions,
  SessionCommandOptions,
  TrendsCommandOptions,
  WrappedCommandOptions,
} from '../usage-data-contracts.js';
import { runEfficiencyReport } from '../run-efficiency-report.js';
import { runOptimizeReport } from '../run-optimize-report.js';
import { runSessionReport } from '../run-session-report.js';
import { runTrendsReport } from '../run-trends-report.js';
import { runUsageReport } from '../run-usage-report.js';
import { runDoctorReport } from '../run-doctor-report.js';
import { runWrappedReport } from '../run-wrapped-report.js';
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
    command: 'npx --yes llm-usage-metrics@latest daily',
    includeInRootHelp: true,
  },
];

function parseGranularityArgument(value: string): ReportGranularity {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly') {
    return normalized;
  }

  throw new Error(`Invalid granularity: ${value}. Expected one of: daily, weekly, monthly`);
}

function createCommand(definition: ReportRuntimeDefinition): Command {
  const command = new Command(definition.meta.commandName);
  command.description(definition.meta.description);
  registerSharedReportOptions(command, definition.meta.sharedOptionProfile);
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
    ],
    weekly: [
      {
        command: 'llm-usage weekly --timezone Europe/Paris',
        includeInRootHelp: true,
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
    ],
  };

  const descriptionByGranularity: Record<ReportGranularity, string> = {
    daily: 'Show daily usage report',
    weekly: 'Show weekly usage report (week starts Monday)',
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
      command.action((options: ReportCommandOptions) => runUsageReport(granularity, options));

      return command;
    },
  };
}

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
    command
      .argument('<granularity>', 'Granularity: daily | weekly | monthly', parseGranularityArgument)
      .option('--repo-dir <path>', 'Path to repository for Git outcome metrics')
      .option('--include-merge-commits', 'Include merge commits in Git outcome metrics')
      .action((granularity: ReportGranularity, options: EfficiencyCommandOptions) =>
        runEfficiencyReport(granularity, options),
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
    command
      .argument('<granularity>', 'Granularity: daily | weekly | monthly', parseGranularityArgument)
      .option(
        '--candidate-model <name>',
        'Candidate model for counterfactual pricing (repeatable or comma-separated)',
        collectRepeatedOption,
      )
      .option('--top <n>', 'Show only the top N cheapest candidates (positive integer)')
      .action((granularity: ReportGranularity, options: OptimizeCommandOptions) =>
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
        command: 'llm-usage trends --metric tokens --days 7',
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
        '--days <n>',
        'Trailing local calendar days to chart; defaults to 30 when no date flags are provided',
      )
      .option('--metric <name>', 'Trend metric: cost | tokens', 'cost')
      .option(
        '--by-source',
        'Render one sparkline row per source instead of a single combined chart',
      )
      .action((options: TrendsCommandOptions) => runTrendsReport(options));

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
        command: 'llm-usage session --markdown',
        includeInCliReference: true,
      },
    ],
  },
  register(command) {
    command
      .option('--top <n>', 'Show only the top N sessions by cost (positive integer)')
      .action((options: SessionCommandOptions) => runSessionReport(options));

    return command;
  },
};

const wrappedReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'wrapped',
    docsLabel: 'wrapped',
    kind: 'specialized',
    description: 'Show a yearly usage recap with optional share SVG',
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
    description: 'Check source discovery health and runtime configuration',
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

const reportDefinitions = [
  createUsageReportDefinition('daily'),
  createUsageReportDefinition('weekly'),
  createUsageReportDefinition('monthly'),
  efficiencyReportDefinition,
  optimizeReportDefinition,
  trendsReportDefinition,
  sessionReportDefinition,
  wrappedReportDefinition,
  doctorReportDefinition,
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
