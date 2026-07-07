import type { Command } from 'commander';

import { getDefaultSourceIds } from '../../sources/create-default-adapters.js';
import type { SharedOptionProfile } from './report-definition-types.js';

const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

type SharedOptionProfileConfig = {
  includeDateFilters: boolean;
  includeMarkdown: boolean;
  includePerModelColumns: boolean;
  includePricing: boolean;
  includeProviderModelFilters: boolean;
  includeHistory: boolean;
  includeShare: boolean;
  includeTimezone: boolean;
};

const sharedOptionProfileConfig: Record<SharedOptionProfile, SharedOptionProfileConfig> = {
  usage: {
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: true,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: true,
    includeTimezone: true,
  },
  specialized: {
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: true,
    includeTimezone: true,
  },
  trends: {
    includeDateFilters: true,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: true,
    includeTimezone: true,
  },
  session: {
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: false,
    includeTimezone: true,
  },
  wrapped: {
    includeDateFilters: false,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: false,
    includeHistory: true,
    includeShare: true,
    includeTimezone: true,
  },
  doctor: {
    includeDateFilters: false,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: false,
    includeProviderModelFilters: false,
    includeHistory: false,
    includeShare: false,
    includeTimezone: false,
  },
};

export function collectRepeatedOption(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

export function getSupportedSourceIds(): string[] {
  return getDefaultSourceIds();
}

export function getAllowedSourcesLabel(supportedSourceIds: readonly string[]): string {
  return supportedSourceIds.join(', ');
}

export function registerSharedReportOptions(
  command: Command,
  profile: SharedOptionProfile,
): Command {
  const supportedSourceIds = getSupportedSourceIds();
  const allowedSourcesLabel = getAllowedSourcesLabel(supportedSourceIds);
  const supportedSourcesSummary = `(${supportedSourceIds.length}): ${allowedSourcesLabel}`;
  const profileConfig = sharedOptionProfileConfig[profile];

  const configuredCommand = command
    .option('--pi-dir <path>', 'Path to .pi sessions directory')
    .option('--codex-dir <path>', 'Path to .codex sessions directory')
    .option('--copilot-dir <path>', 'Path to GitHub Copilot OTEL directory')
    .option('--gemini-dir <path>', 'Path to .gemini directory')
    .option('--droid-dir <path>', 'Path to Droid sessions directory')
    .option('--claude-dir <path>', 'Path to Claude projects directory')
    .option('--openclaw-dir <path>', 'Path to OpenClaw agents directory')
    .option('--opencode-db <path>', 'Path to OpenCode SQLite DB')
    .option('--goose-db <path>', 'Path to Goose SQLite DB')
    .option('--amp-dir <path>', 'Path to Amp threads directory')
    .option('--qwen-dir <path>', 'Path to Qwen projects directory')
    .option('--kimi-dir <path>', 'Path to Kimi sessions directory')
    .option('--cline-dir <path>', 'Path to Cline tasks directory')
    .option('--roocode-dir <path>', 'Path to RooCode tasks directory')
    .option('--kilocode-dir <path>', 'Path to KiloCode tasks directory')
    .option('--antigravity-dir <path>', 'Path to Antigravity conversations directory')
    .option(
      '--source-dir <source-id=path>',
      'Override source directory for directory-backed sources (repeatable)',
      collectRepeatedOption,
    )
    .option(
      '--source <name>',
      `Filter by source id (repeatable or comma-separated, supported sources ${supportedSourcesSummary})`,
      collectRepeatedOption,
    )
    .option('--json', 'Render output as JSON');

  if (profileConfig.includeDateFilters) {
    configuredCommand
      .option('--since <YYYY-MM-DD>', 'Inclusive start date filter')
      .option('--until <YYYY-MM-DD>', 'Inclusive end date filter');
  }

  if (profileConfig.includeTimezone) {
    configuredCommand.option('--timezone <iana>', 'Timezone for bucketing', defaultTimezone);
  }

  if (profileConfig.includeProviderModelFilters) {
    configuredCommand
      .option(
        '--provider <name>',
        'Billing-provider filter (normalized to billing entity; e.g. openai, anthropic, google, moonshot)',
      )
      .option(
        '--model <name>',
        'Filter by model (repeatable/comma-separated; exact when exact match exists after source/provider/date filters, otherwise substring)',
        collectRepeatedOption,
      );
  }

  if (profileConfig.includePricing) {
    configuredCommand
      .option('--pricing-url <url>', 'Override LiteLLM pricing source URL')
      .option(
        '--pricing-overrides <path>',
        'Path to a JSON file of per-model pricing overrides (takes precedence over LiteLLM)',
      )
      .option('--pricing-offline', 'Use cached LiteLLM pricing only (no network fetch)')
      .option(
        '--ignore-pricing-failures',
        'Continue without estimated costs when pricing cannot be loaded',
      );
  }

  if (profileConfig.includeHistory) {
    configuredCommand.option(
      '--history',
      'include usage from files that no longer exist on disk (from the local event store)',
    );
  }

  if (profileConfig.includeMarkdown) {
    configuredCommand.option('--markdown', 'Render output as markdown table');
  }

  if (profileConfig.includePerModelColumns) {
    configuredCommand.option(
      '--per-model-columns',
      'Render per-model metrics as multiline aligned table columns (terminal/markdown)',
    );
  }

  if (profileConfig.includeShare) {
    configuredCommand.option('--share', 'Write a share SVG image to the current directory');
  }

  return configuredCommand;
}
