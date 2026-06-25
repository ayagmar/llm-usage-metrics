#!/usr/bin/env node

import { getUpdateNotifierRuntimeConfig } from '../config/runtime-overrides.js';
import { checkForUpdatesAndMaybeRestart } from '../update/update-notifier.js';
import { createCli } from './create-cli.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';

const { packageName, packageVersion } = loadPackageMetadataFromRuntime();
const updateRuntimeConfig = getUpdateNotifierRuntimeConfig();
const cli = createCli({ version: packageVersion });

async function main(): Promise<void> {
  const updateResult = await checkForUpdatesAndMaybeRestart({
    packageName,
    currentVersion: packageVersion,
    cacheTtlMs: updateRuntimeConfig.cacheTtlMs,
    fetchTimeoutMs: updateRuntimeConfig.fetchTimeoutMs,
  });

  if (!updateResult.continueExecution) {
    process.exitCode = updateResult.exitCode ?? 0;
  } else {
    await cli.parseAsync(process.argv);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
