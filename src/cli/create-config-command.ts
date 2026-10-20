import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Command } from 'commander';

import {
  EVENT_STORE_ENABLED_DEFAULT,
  PARSE_MAX_PARALLEL_DEFAULT,
  PARSE_WORKER_MIN_BYTES_DEFAULT,
  PARSE_WORKERS_CONFIG_DEFAULT,
  PRICING_CACHE_TTL_DEFAULT_MS,
  PRICING_FETCH_TIMEOUT_DEFAULT_MS,
  UPDATE_CACHE_TTL_DEFAULT_MS,
  UPDATE_FETCH_TIMEOUT_DEFAULT_MS,
} from '../config/runtime-overrides.js';
import { resolveUserConfigPath, USER_CONFIG_SOURCE_DIR_KEYS } from '../config/user-config.js';
import { getDefaultEventStorePath } from '../persistence/event-store.js';
import { ensureDirectory } from '../utils/fs-helpers.js';
import { logger } from '../utils/logger.js';
import { renderConfigReportText } from '../render/render-config-report.js';
import { renderReportJson } from '../render/report-json.js';
import { buildConfigReport, type BuildConfigReportDeps } from './build-config-report.js';
import { formatHelpExamples } from './report-definitions/report-definitions.js';
import { registerSharedReportOptions } from './report-definitions/shared-report-options.js';
import { prepareReport, runPreparedReport } from './report-runtime/report-lifecycle.js';
import type { ConfigShowCommandOptions } from './usage-data-contracts.js';
import { DEFAULT_LITELLM_PRICING_URL, hasErrorCode } from '@ayagmar/agent-sessions/internal';

type ConfigInitOptions = {
  force?: boolean;
};

const CONFIG_TEMPLATE_HEADER = `#:schema https://ayagmar.github.io/llm-usage-metrics/config-schema.json
# llm-usage-metrics configuration. Uncomment a key to override its default.
`;

const sourceDirTemplate = USER_CONFIG_SOURCE_DIR_KEYS.map((sourceId) => `# ${sourceId} = ""`).join(
  '\n',
);

export const USER_CONFIG_TEMPLATE = `${CONFIG_TEMPLATE_HEADER}
# Default: system timezone.
# timezone = ""

# Stderr logging level: silent, warn, info, or debug.
# logLevel = "info"

# Default: all supported sources.
# sources = []

# Monthly budget in USD. When set, the summary compares month-to-date spend and
# the month-end projection against it. Default: no budget.
# monthlyBudgetUsd = 100

# Parser defaults.
# parseMaxParallel = ${PARSE_MAX_PARALLEL_DEFAULT}
# parseWorkers = "${PARSE_WORKERS_CONFIG_DEFAULT}"
# parseWorkerMinBytes = ${PARSE_WORKER_MIN_BYTES_DEFAULT}

# Default source path overrides. Directory sources (all except opencode and
# goose) also accept a list of paths to scan several directories.
# [sourceDirs]
${sourceDirTemplate}

# Pricing defaults.
# [pricing]
# offline = false
# url = "${DEFAULT_LITELLM_PRICING_URL}"
# overridesPath = ""
# ignoreFailures = false
# cacheTtlMs = ${PRICING_CACHE_TTL_DEFAULT_MS}
# fetchTimeoutMs = ${PRICING_FETCH_TIMEOUT_DEFAULT_MS}

# Event store defaults.
# [eventStore]
# enabled = ${String(EVENT_STORE_ENABLED_DEFAULT)}
# path = ${JSON.stringify(getDefaultEventStorePath())}

# Update-check defaults.
# [update]
# skipCheck = false
# cacheTtlMs = ${UPDATE_CACHE_TTL_DEFAULT_MS}
# fetchTimeoutMs = ${UPDATE_FETCH_TIMEOUT_DEFAULT_MS}

# Other machines to sync usage from over ssh; each needs llm-usage-metrics
# installed and ssh login without a prompt. \`llm-usage machine add\` checks
# the connection and writes the table for you.
# [machines.laptop]
# ssh = "me@laptop.local"
# command = "llm-usage"
# enabled = true
`;

async function writeConfigTemplate(configPath: string, options: ConfigInitOptions): Promise<void> {
  await ensureDirectory(path.dirname(configPath));

  try {
    await writeFile(configPath, USER_CONFIG_TEMPLATE, {
      encoding: 'utf8',
      flag: options.force === true ? 'w' : 'wx',
    });
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(`Config file already exists: ${configPath} (use --force to overwrite)`, {
        cause: error,
      });
    }

    throw error;
  }
}

export async function runConfigShow(
  options: ConfigShowCommandOptions,
  deps: BuildConfigReportDeps & { now?: () => number } = {},
): Promise<void> {
  const { data, warnings } = await buildConfigReport(options, deps);

  for (const warning of warnings) {
    logger.warn(warning);
  }

  const preparedReport = await prepareReport({
    commandOptions: options,
    supportedFormats: ['terminal', 'json'] as const,
    buildData: async () => data,
    render: (reportData, format) =>
      format === 'json'
        ? renderReportJson('config-show', reportData)
        : renderConfigReportText(reportData, { now: (deps.now ?? Date.now)() }),
    getDiagnostics: () => undefined,
  });
  await runPreparedReport({ preparedReport });
}

export function createConfigCommand(): Command {
  const configCommand = new Command('config')
    .description('Manage user configuration')
    .addHelpText(
      'after',
      formatHelpExamples([
        'llm-usage config init',
        'llm-usage config show',
        'llm-usage config path',
      ]),
    );
  const initCommand = new Command('init')
    .description('Write a commented config template')
    .option('--force', 'Overwrite an existing config file')
    .addHelpText(
      'after',
      formatHelpExamples(['llm-usage config init', 'llm-usage config init --force']),
    )
    .action(async (options: ConfigInitOptions) => {
      const configPath = resolveUserConfigPath(process.env);
      await writeConfigTemplate(configPath, options);
      logger.info(`Wrote config template: ${configPath}`);
    });
  const pathCommand = new Command('path')
    .description('Print the resolved config file path')
    .addHelpText(
      'after',
      formatHelpExamples(['llm-usage config path', '$EDITOR "$(llm-usage config path)"']),
    )
    .action(() => {
      console.log(resolveUserConfigPath(process.env));
    });
  const showCommand = registerSharedReportOptions(
    new Command('show').description(
      'Print the effective configuration and where each value comes from',
    ),
    'config',
  )
    .addHelpText(
      'after',
      formatHelpExamples([
        'llm-usage config show',
        'llm-usage config show --json',
        'llm-usage config show --claude-dir ~/work/.claude/projects',
        'LLM_USAGE_CONFIG_PATH=./work.toml llm-usage config show',
      ]),
    )
    .action(async (options: ConfigShowCommandOptions) => {
      await runConfigShow(options);
    });

  configCommand.addCommand(initCommand);
  configCommand.addCommand(showCommand);
  configCommand.addCommand(pathCommand);
  return configCommand;
}
