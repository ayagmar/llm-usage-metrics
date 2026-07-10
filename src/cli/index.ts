#!/usr/bin/env node

import { isMainThread, workerData } from 'node:worker_threads';

import { getUpdateNotifierRuntimeConfig } from '../config/runtime-overrides.js';
import { loadUserConfig, type UserConfig } from '../config/user-config.js';
import { checkForUpdates, waitForUpdateHintBeforeExit } from '../update/update-notifier.js';
import { logger, setLogLevel } from '../utils/logger.js';
import { createCli } from './create-cli.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';
import { isParseWorkerRequest, runParseWorker } from './parse-worker-pool.js';

async function loadConfigForUpdateCheck(): Promise<UserConfig> {
  try {
    return (await loadUserConfig()).config;
  } catch {
    // A malformed config must not block `--help`/`--version`. Real command
    // runs re-load the config on the command path and re-throw the actionable
    // parse error there.
    return {};
  }
}

async function runCli(): Promise<void> {
  const { packageName, packageVersion } = loadPackageMetadataFromRuntime();
  const cli = createCli({ version: packageVersion });
  const config = await loadConfigForUpdateCheck();
  setLogLevel(config.logLevel ?? 'info');
  const updateRuntimeConfig = getUpdateNotifierRuntimeConfig(process.env, config);
  const updateAbortController = new AbortController();
  const updateHintPromise = checkForUpdates({
    packageName,
    currentVersion: packageVersion,
    skipCheck: updateRuntimeConfig.skipCheck,
    cacheTtlMs: updateRuntimeConfig.cacheTtlMs,
    fetchTimeoutMs: updateRuntimeConfig.fetchTimeoutMs,
    signal: updateAbortController.signal,
  });

  try {
    await cli.parseAsync(process.argv);
  } finally {
    const updateHint = await waitForUpdateHintBeforeExit(updateHintPromise, updateAbortController);

    if (updateHint) {
      logger.info(updateHint);
    }
  }
}

const currentWorkerData: unknown = workerData;

const mainPromise =
  !isMainThread && isParseWorkerRequest(currentWorkerData) ? runParseWorker() : runCli();

mainPromise.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
