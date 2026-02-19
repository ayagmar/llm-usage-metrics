import { Command } from 'commander';

import { getDefaultSourceIds } from '../sources/create-default-adapters.js';
import { runUsageReport } from './run-usage-report.js';
import type { ReportCommandOptions } from './usage-data-contracts.js';
import type { ReportGranularity } from '../utils/time-buckets.js';

export type CreateCliOptions = {
  version?: string;
};

const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function collectSourceOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function getAllowedSourcesLabel(): string {
  return getDefaultSourceIds().join(',');
}

function addSharedOptions(command: Command): Command {
  const allowedSourcesLabel = getAllowedSourcesLabel();

  return command
    .option('--pi-dir <path>', 'Path to .pi sessions directory')
    .option('--codex-dir <path>', 'Path to .codex sessions directory')
    .option('--opencode-db <path>', 'Path to OpenCode SQLite DB')
    .option(
      '--source-dir <source-id=path>',
      'Override source directory for directory-backed sources (repeatable)',
      collectSourceOption,
      [],
    )
    .option(
      '--source <name>',
      `Filter by source id (repeatable or comma-separated, allowed: ${allowedSourcesLabel})`,
      collectSourceOption,
      [],
    )
    .option('--since <YYYY-MM-DD>', 'Inclusive start date filter')
    .option('--until <YYYY-MM-DD>', 'Inclusive end date filter')
    .option('--timezone <iana>', 'Timezone for bucketing', defaultTimezone)
    .option('--provider <name>', 'Provider filter (substring match, optional)')
    .option(
      '--model <name>',
      'Filter by model (repeatable/comma-separated; exact when exact match exists after source/provider/date filters, otherwise substring)',
      collectSourceOption,
      [],
    )
    .option('--pricing-url <url>', 'Override LiteLLM pricing source URL')
    .option('--pricing-offline', 'Use cached LiteLLM pricing only (no network fetch)')
    .option('--markdown', 'Render output as markdown table')
    .option('--json', 'Render output as JSON')
    .option(
      '--per-model-columns',
      'Render per-model metrics as multiline aligned table columns (terminal/markdown)',
    );
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

  addSharedOptions(command)
    .description(commandDescription(granularity))
    .action(async (options: ReportCommandOptions) => {
      await runUsageReport(granularity, options);
    });

  return command;
}

function rootDescription(): string {
  const allowedSourcesLabel = getAllowedSourcesLabel();

  return [
    'Aggregate local LLM usage metrics from supported local session sources',
    '',
    'Run `llm-usage <command> --help` to see command options (e.g. --json, --source).',
    '',
    'Examples:',
    '  $ llm-usage daily',
    '  $ llm-usage daily --help',
    '  $ llm-usage weekly --timezone Europe/Paris',
    `  $ llm-usage monthly --since 2026-01-01 --until 2026-01-31 --source ${allowedSourcesLabel} --json`,
    '  $ llm-usage monthly --model claude --per-model-columns',
    '  $ llm-usage daily --source-dir pi=/tmp/pi-sessions',
    '  $ npx --yes llm-usage-metrics daily',
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
    .addCommand(createCommand('monthly'));

  return program;
}
