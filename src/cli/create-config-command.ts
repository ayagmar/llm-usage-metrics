import { mkdir, writeFile } from 'node:fs/promises';
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
import { DEFAULT_LITELLM_PRICING_URL } from '../pricing/litellm-pricing-fetcher.js';
import { asRecord } from '../utils/as-record.js';
import { logger } from '../utils/logger.js';

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

# Parser defaults.
# parseMaxParallel = ${PARSE_MAX_PARALLEL_DEFAULT}
# parseWorkers = "${PARSE_WORKERS_CONFIG_DEFAULT}"
# parseWorkerMinBytes = ${PARSE_WORKER_MIN_BYTES_DEFAULT}

# Default source path overrides.
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
# path = "~/.cache/llm-usage-metrics/events.db"

# Update-check defaults.
# [update]
# skipCheck = false
# cacheTtlMs = ${UPDATE_CACHE_TTL_DEFAULT_MS}
# fetchTimeoutMs = ${UPDATE_FETCH_TIMEOUT_DEFAULT_MS}
`;

function isExistingFileError(error: unknown): boolean {
  return asRecord(error)?.code === 'EEXIST';
}

async function writeConfigTemplate(configPath: string, options: ConfigInitOptions): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });

  try {
    await writeFile(configPath, USER_CONFIG_TEMPLATE, {
      encoding: 'utf8',
      flag: options.force === true ? 'w' : 'wx',
    });
  } catch (error) {
    if (isExistingFileError(error)) {
      throw new Error(`Config file already exists: ${configPath} (use --force to overwrite)`, {
        cause: error,
      });
    }

    throw error;
  }
}

export function createConfigCommand(): Command {
  const configCommand = new Command('config').description('Manage user configuration');
  const initCommand = new Command('init')
    .description('Write a commented config template')
    .option('--force', 'Overwrite an existing config file')
    .action(async (options: ConfigInitOptions) => {
      const configPath = resolveUserConfigPath(process.env);
      await writeConfigTemplate(configPath, options);
      logger.info(`Wrote config template: ${configPath}`);
    });

  configCommand.addCommand(initCommand);
  return configCommand;
}
