import { Command } from 'commander';

import { getDefaultSourceIds } from '../sources/create-default-adapters.js';
import { runEfficiencyReport } from './run-efficiency-report.js';
import { runOptimizeReport } from './run-optimize-report.js';
import { runUsageReport } from './run-usage-report.js';
import type {
  EfficiencyCommandOptions,
  OptimizeCommandOptions,
  ReportCommandOptions,
} from './usage-data-contracts.js';
import type { ReportGranularity } from '../utils/time-buckets.js';

export type CreateCliOptions = {
  version?: string;
};

const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function getSupportedSourceIds(): string[] {
  return getDefaultSourceIds();
}

function getAllowedSourcesLabel(supportedSourceIds: readonly string[]): string {
  return supportedSourceIds.join(', ');
}

function addSharedOptions(
  command: Command,
  options: { includePerModelColumns?: boolean } = {},
): Command {
  const supportedSourceIds = getSupportedSourceIds();
  const allowedSourcesLabel = getAllowedSourcesLabel(supportedSourceIds);
  const supportedSourcesSummary = `(${supportedSourceIds.length}): ${allowedSourcesLabel}`;
  const includePerModelColumns = options.includePerModelColumns ?? true;

  const configuredCommand = command
    .option('--pi-dir <path>', 'Path to .pi sessions directory')
    .option('--codex-dir <path>', 'Path to .codex sessions directory')
    .option('--gemini-dir <path>', 'Path to .gemini directory')
    .option('--droid-dir <path>', 'Path to Droid sessions directory')
    .option('--opencode-db <path>', 'Path to OpenCode SQLite DB')
    .option(
      '--source-dir <source-id=path>',
      'Override source directory for directory-backed sources (repeatable)',
      collectRepeatedOption,
      [],
    )
    .option(
      '--source <name>',
      `Filter by source id (repeatable or comma-separated, supported sources ${supportedSourcesSummary})`,
      collectRepeatedOption,
      [],
    )
    .option('--since <YYYY-MM-DD>', 'Inclusive start date filter')
    .option('--until <YYYY-MM-DD>', 'Inclusive end date filter')
    .option('--timezone <iana>', 'Timezone for bucketing', defaultTimezone)
    .option(
      '--provider <name>',
      'Billing-provider filter (substring match, optional; e.g. openai, anthropic, google)',
    )
    .option(
      '--model <name>',
      'Filter by model (repeatable/comma-separated; exact when exact match exists after source/provider/date filters, otherwise substring)',
      collectRepeatedOption,
      [],
    )
    .option('--pricing-url <url>', 'Override LiteLLM pricing source URL')
    .option('--pricing-offline', 'Use cached LiteLLM pricing only (no network fetch)')
    .option(
      '--ignore-pricing-failures',
      'Continue without estimated costs when pricing cannot be loaded',
    )
    .option('--markdown', 'Render output as markdown table')
    .option('--json', 'Render output as JSON');

  if (!includePerModelColumns) {
    return configuredCommand;
  }

  return configuredCommand.option(
    '--per-model-columns',
    'Render per-model metrics as multiline aligned table columns (terminal/markdown)',
  );
}

function addShareOption(command: Command): Command {
  return command.option('--share', 'Write a share SVG image to the current directory');
}

function commandDescription(granularity: ReportGranularity): string {
  switch (granularity) {
    case 'daily':
      return 'Show daily usage report';
    case 'weekly':
      return 'Show weekly usage report (week starts Monday)';
    case 'monthly':
      return 'Show monthly usage report';
  }
}

function createCommand(granularity: ReportGranularity): Command {
  const command = new Command(granularity);

  addShareOption(addSharedOptions(command))
    .description(commandDescription(granularity))
    .action(async (options: ReportCommandOptions) => {
      await runUsageReport(granularity, options);
    });

  return command;
}

function parseGranularityArgument(value: string): ReportGranularity {
  const normalized = value.trim().toLowerCase();

  if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly') {
    return normalized;
  }

  throw new Error(`Invalid granularity: ${value}. Expected one of: daily, weekly, monthly`);
}

function createEfficiencyCommand(): Command {
  const command = new Command('efficiency');

  addShareOption(addSharedOptions(command, { includePerModelColumns: false }))
    .argument('<granularity>', 'Granularity: daily | weekly | monthly', parseGranularityArgument)
    .option('--repo-dir <path>', 'Path to repository for Git outcome metrics')
    .option('--include-merge-commits', 'Include merge commits in Git outcome metrics')
    .description('Show efficiency report by correlating usage metrics with local Git outcomes')
    .action(async (granularity: ReportGranularity, options: EfficiencyCommandOptions) => {
      await runEfficiencyReport(granularity, options);
    });

  return command;
}

function createOptimizeCommand(): Command {
  const command = new Command('optimize');

  addShareOption(addSharedOptions(command, { includePerModelColumns: false }))
    .argument('<granularity>', 'Granularity: daily | weekly | monthly', parseGranularityArgument)
    .option(
      '--candidate-model <name>',
      'Candidate model for counterfactual pricing (repeatable or comma-separated)',
      collectRepeatedOption,
      [],
    )
    .option('--top <n>', 'Show only the top N cheapest candidates (positive integer)')
    .description('Show counterfactual pricing report for candidate model(s)')
    .action(async (granularity: ReportGranularity, options: OptimizeCommandOptions) => {
      await runOptimizeReport(granularity, options);
    });

  return command;
}

function rootDescription(): string {
  const supportedSourceIds = getSupportedSourceIds();
  const allowedSourcesLabel = getAllowedSourcesLabel(supportedSourceIds);

  return [
    'Aggregate local LLM usage metrics from supported local session sources',
    `Supported sources (${supportedSourceIds.length}): ${allowedSourcesLabel}`,
    '',
    'Run `llm-usage <command> --help` to see command options (e.g. --json, --source).',
    '',
    'Examples:',
    '  $ llm-usage daily',
    '  $ llm-usage daily --help',
    '  $ llm-usage weekly --timezone Europe/Paris',
    '  $ llm-usage monthly --since 2026-01-01 --until 2026-01-31 --source pi,codex --json',
    '  $ llm-usage monthly --source opencode --opencode-db /path/to/opencode.db --json',
    '  $ llm-usage monthly --model claude --per-model-columns',
    '  $ llm-usage daily --source-dir pi=/tmp/pi-sessions --source-dir gemini=/tmp/.gemini --source-dir droid=/tmp/droid-sessions',
    '  $ llm-usage daily --pi-dir /tmp/pi-sessions --gemini-dir /tmp/.gemini --droid-dir /tmp/droid-sessions',
    '  $ llm-usage efficiency weekly --repo-dir /path/to/repo --json',
    '  $ llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --json',
    '  $ npx --yes llm-usage-metrics@latest daily',
  ].join('\n');
}

export function createCli(options: CreateCliOptions = {}): Command {
  const program = new Command();

  program
    .name('llm-usage')
    .description(rootDescription())
    .version(options.version ?? '0.0.0')
    .showHelpAfterError()
    .addCommand(createCommand('daily'))
    .addCommand(createCommand('weekly'))
    .addCommand(createCommand('monthly'))
    .addCommand(createEfficiencyCommand())
    .addCommand(createOptimizeCommand());

  return program;
}
