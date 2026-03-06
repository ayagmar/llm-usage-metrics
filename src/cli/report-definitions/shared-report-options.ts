import type { Command } from 'commander';

import { getDefaultSourceIds } from '../../sources/create-default-adapters.js';
import type { SharedOptionProfile } from './report-definition-types.js';

const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

type SharedOptionProfileConfig = {
  includeMarkdown: boolean;
  includePerModelColumns: boolean;
  includeShare: boolean;
};

const sharedOptionProfileConfig: Record<SharedOptionProfile, SharedOptionProfileConfig> = {
  usage: {
    includeMarkdown: true,
    includePerModelColumns: true,
    includeShare: true,
  },
  specialized: {
    includeMarkdown: true,
    includePerModelColumns: false,
    includeShare: true,
  },
  trends: {
    includeMarkdown: false,
    includePerModelColumns: false,
    includeShare: false,
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
    .option('--gemini-dir <path>', 'Path to .gemini directory')
    .option('--droid-dir <path>', 'Path to Droid sessions directory')
    .option('--opencode-db <path>', 'Path to OpenCode SQLite DB')
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
    )
    .option('--pricing-url <url>', 'Override LiteLLM pricing source URL')
    .option('--pricing-offline', 'Use cached LiteLLM pricing only (no network fetch)')
    .option(
      '--ignore-pricing-failures',
      'Continue without estimated costs when pricing cannot be loaded',
    )
    .option('--json', 'Render output as JSON');

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
