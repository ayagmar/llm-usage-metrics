import { type Command, Option } from 'commander';

import { getDefaultSourceIds } from '@ayagmar/agent-sessions/registry';
import { getSourceOverrideOptions } from '../source-cli-options.js';
import type { PricingCostMode } from '../../pricing/cost-engine.js';
import type { SharedOptionProfile } from './report-definition-types.js';

const COST_MODES = ['explicit', 'estimated', 'both'] as const satisfies readonly PricingCostMode[];

export type SharedOptionProfileConfig = {
  /** --source, --source-dir, the per-source path flags and --help-all. */
  includeSources: boolean;
  includeVerbose: boolean;
  includeJson: boolean;
  /** Where to point `--json` on a command without it, instead of an unknown-option error. */
  jsonAlternative?: string;
  includeQuiet: boolean;
  includeDateFilters: boolean;
  includeMarkdown: boolean;
  includePerModelColumns: boolean;
  includePricing: boolean;
  /** --ignore-pricing-failures and --cost-mode, for commands that price usage. */
  includeCostOptions: boolean;
  /** --pricing-url and --pricing-offline, for commands that may fetch prices. */
  includePricingFetch: boolean;
  includeProviderModelFilters: boolean;
  includeHistory: boolean;
  /** --no-sync, for commands that may refresh other machines over ssh. */
  includeSync: boolean;
  includeShare: boolean;
  includeTimezone: boolean;
};

export const sharedOptionProfileConfig = {
  usage: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: true,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: true,
    includeTimezone: true,
  },
  // hourly: the usage profile without --share.
  hourly: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: true,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: false,
    includeTimezone: true,
  },
  // projects, blocks and value: the usage profile without --share and --per-model-columns.
  rollup: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: false,
    includeTimezone: true,
  },
  summary: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: false,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: true,
    includeTimezone: true,
  },
  specialized: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: true,
    includeTimezone: true,
  },
  compare: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: true,
    includeTimezone: true,
  },
  trends: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: true,
    includeTimezone: true,
  },
  session: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: false,
    includeTimezone: true,
  },
  wrapped: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: false,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: true,
    includeTimezone: true,
  },
  events: {
    includeSources: true,
    includeVerbose: true,
    includeJson: false,
    jsonAlternative: 'use --format jsonl',
    includeQuiet: true,
    includeDateFilters: true,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: true,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: true,
    includeShare: false,
    includeTimezone: true,
  },
  statusline: {
    includeSources: true,
    includeVerbose: true,
    includeJson: false,
    jsonAlternative: 'use llm-usage summary --json',
    includeQuiet: false,
    includeDateFilters: false,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: true,
    includePricingFetch: false,
    includeProviderModelFilters: true,
    includeHistory: true,
    includeSync: false,
    includeShare: false,
    includeTimezone: true,
  },
  doctor: {
    includeSources: true,
    includeVerbose: true,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: false,
    includeMarkdown: false,
    includePerModelColumns: false,
    includePricing: false,
    includeCostOptions: false,
    includePricingFetch: false,
    includeProviderModelFilters: false,
    includeHistory: false,
    includeSync: false,
    includeShare: false,
    includeTimezone: false,
  },
  // pricing <model...>: only what decides which prices load, the output format and --quiet.
  pricing: {
    includeSources: false,
    includeVerbose: false,
    includeJson: true,
    includeQuiet: true,
    includeDateFilters: false,
    includeMarkdown: true,
    includePerModelColumns: false,
    includePricing: true,
    includeCostOptions: false,
    includePricingFetch: true,
    includeProviderModelFilters: false,
    includeHistory: false,
    includeSync: false,
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

/** Turns `--json` on a command without it into an error that names the alternative. */
function redirectUnsupportedJson(command: Command, alternative: string): void {
  if (!hasUnknownOptionHook(command)) {
    return;
  }

  const reportUnknownOption = command.unknownOption.bind(command);

  command.unknownOption = (flag) => {
    if (flag === '--json') {
      command.error(`error: --json is not supported for ${command.name()}; ${alternative}`, {
        code: 'commander.unknownOption',
      });
    }

    reportUnknownOption(flag);
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
        ? '\nPer-source path flags (--claude-dir, ...)\nare listed by --help-all.'
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

  if (profileConfig.includeSources) {
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
      );
  }

  if (profileConfig.includeJson) {
    configuredCommand.option('--json', 'Render output as JSON');
  } else {
    redirectUnsupportedJson(configuredCommand, profileConfig.jsonAlternative);
  }

  if (profileConfig.includeQuiet) {
    configuredCommand.option(
      '--quiet',
      'Suppress informational stderr output (warnings still print)',
    );
  }

  if (profileConfig.includeVerbose) {
    configuredCommand.option(
      '--verbose',
      'Print detailed diagnostics on stderr (per-source counts, routine skips, config, env)',
    );
  }

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
    if (profileConfig.includePricingFetch) {
      configuredCommand.option('--pricing-url <url>', 'Override LiteLLM pricing source URL');
    }

    configuredCommand.option(
      '--pricing-overrides <path>',
      'Path to a JSON file of per-model pricing overrides (takes precedence over LiteLLM)',
    );

    if (profileConfig.includePricingFetch) {
      configuredCommand.option(
        '--pricing-offline',
        'Use cached LiteLLM pricing only (no network fetch)',
      );
    }

    if (profileConfig.includeCostOptions) {
      configuredCommand.option(
        '--ignore-pricing-failures',
        'Continue without estimated costs when pricing cannot be loaded',
      );

      // No default here: `both` applies downstream, so --no-cost conflicts only with a passed mode.
      configuredCommand.addOption(
        new Option(
          '--cost-mode <mode>',
          'Costs to report: explicit (logged by the source), estimated (from LiteLLM), or both (logged, else estimated; default)',
        ).choices(COST_MODES),
      );
    }
  }

  if (profileConfig.includeHistory) {
    configuredCommand
      .option(
        '--history',
        'Include usage from files that no longer exist on disk (on by default; when passed, fails if the event store is unavailable)',
      )
      .option('--no-history', 'Leave out usage from files that no longer exist on disk')
      .option(
        '--machine <name>',
        'Count only these machines (repeatable or comma-separated; local is this one; default: all)',
        collectRepeatedOption,
      );

    if (profileConfig.includeSync) {
      configuredCommand.option(
        '--no-sync',
        "Use other machines' cached usage without refreshing it over ssh",
      );
    }
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
      .option('--share', 'Write an interactive HTML report to the current directory')
      .option('--no-open', 'With --share, write the report without opening it')
      .option('--redact', 'With --share, label projects project-N and machines machine-N');
  }

  return configuredCommand;
}
