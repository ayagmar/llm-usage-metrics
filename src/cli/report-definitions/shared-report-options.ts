import { type Command, Option } from 'commander';

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
  summary: {
    includeDateFilters: false,
    includeMarkdown: true,
    includePerModelColumns: false,
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
    includeShare: true,
    includeTimezone: true,
  },
  trends: {
    includeDateFilters: true,
    includeMarkdown: true,
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
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: true,
    includeTimezone: true,
  },
  events: {
    includeDateFilters: true,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: false,
    includeTimezone: true,
  },
  statusline: {
    includeDateFilters: false,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeShare: false,
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

/** Shows options hidden from regular help (the per-source path flags) on a command tree. */
export function revealHiddenOptions(command: Command): void {
  for (const option of command.options) {
    option.hidden = false;
  }

  for (const subcommand of command.commands) {
    revealHiddenOptions(subcommand);
  }
}

function hasHiddenOptions(command: Command): boolean {
  return command.options.some((option) => option.hidden);
}

/** Commander's unknown-option hook; untyped in its declarations, present at runtime. */
type UnknownOptionHook = { unknownOption: (flag: string) => void };

/**
 * Commander suggests only options shown in help, so a typo of a hidden path flag
 * (`--claud-dir`) would lose its "Did you mean --claude-dir?". Reveal them while the
 * error is built.
 */
function hasUnknownOptionHook(command: Command): command is Command & UnknownOptionHook {
  return typeof Reflect.get(command, 'unknownOption') === 'function';
}

function suggestHiddenOptionsOnTypo(command: Command): void {
  if (!hasUnknownOptionHook(command)) {
    return;
  }

  const reportUnknownOption = command.unknownOption.bind(command);

  command.unknownOption = (flag) => {
    const hiddenOptions = command.options.filter((option) => option.hidden);

    for (const option of hiddenOptions) {
      option.hidden = false;
    }

    try {
      reportUnknownOption(flag);
    } finally {
      for (const option of hiddenOptions) {
        option.hidden = true;
      }
    }
  };
}

/**
 * The 17 per-source path flags crowd every report's help, so they stay out of it;
 * `--help-all` prints the help with them.
 */
function registerSourcePathOptions(command: Command): void {
  for (const overrideOption of getSourceOverrideOptions()) {
    const option = new Option(
      overrideOption.flag,
      overrideOption.supportsSourceDir
        ? `${overrideOption.help} (repeatable)`
        : overrideOption.help,
    ).hideHelp();

    if (overrideOption.supportsSourceDir) {
      option.argParser(collectRepeatedOption);
    }

    command.addOption(option);
  }

  command
    .option('--help-all', 'Display help including the per-source path flags')
    .on('option:help-all', () => {
      revealHiddenOptions(command);
      command.help();
    })
    .addHelpText('after', () =>
      hasHiddenOptions(command)
        ? '\nPer-source path flags (--claude-dir, --codex-dir, --opencode-db, ...) are\nlisted by --help-all.'
        : '',
    );

  suggestHiddenOptionsOnTypo(command);
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

  registerSourcePathOptions(configuredCommand);

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
    .option('--quiet', 'Suppress informational stderr output (warnings still print)')
    .option(
      '--verbose',
      'Print detailed diagnostics on stderr (per-source counts, routine skips, config, env)',
    );

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
    configuredCommand
      .option(
        '--history',
        'include usage from files that no longer exist on disk (the default; fails if the event store is unavailable)',
      )
      .option('--no-history', 'leave out usage from files that no longer exist on disk')
      .option(
        '--machine <name>',
        'Count only these machines (repeatable or comma-separated; local is this one; default: all)',
        collectRepeatedOption,
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
    configuredCommand
      .option(
        '--share',
        'Write a share card (SVG and an HTML page with PNG export) to the current directory',
      )
      .option('--no-open', 'With --share, write the files without opening the page');
  }

  return configuredCommand;
}
