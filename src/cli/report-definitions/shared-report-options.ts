import type { Command } from 'commander';

import {
  getDefaultSourceIds,
  getSourceOverrideOptions,
} from '../../sources/create-default-adapters.js';
import type { SharedOptionProfile } from './report-definition-types.js';

export type SharedOptionProfileConfig = {
  includeDateFilters: boolean;
  includeMarkdown: boolean;
  includePerModelColumns: boolean;
  includePricing: boolean;
  includeProviderModelFilters: boolean;
  includeHistory: boolean;
  includeShare: boolean;
  includeTimezone: boolean;
};

export const sharedOptionProfileConfig = {
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
  compare: {
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: false,
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
    includeProviderModelFilters: true,
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
} as const satisfies Record<SharedOptionProfile, SharedOptionProfileConfig>;

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

  const configuredCommand = command;

  for (const overrideOption of getSourceOverrideOptions()) {
    configuredCommand.option(overrideOption.flag, overrideOption.help);
  }

  configuredCommand
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
    .option('--json', 'Render output as JSON')
    .option('--quiet', 'Suppress informational stderr output (warnings still print)');

  if (profileConfig.includeDateFilters) {
    configuredCommand
      .option('--since <YYYY-MM-DD>', 'Inclusive start date filter')
      .option('--until <YYYY-MM-DD>', 'Inclusive end date filter');
  }

  if (profileConfig.includeTimezone) {
    configuredCommand.option(
      '--timezone <iana>',
      'Timezone for bucketing (default: system timezone)',
    );
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
