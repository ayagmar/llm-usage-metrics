#!/usr/bin/env node

import { getUpdateNotifierRuntimeConfig } from '../config/runtime-overrides.js';
import { checkForUpdates } from '../update/update-notifier.js';
import { createCli } from './create-cli.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';

const { packageName, packageVersion } = loadPackageMetadataFromRuntime();
const updateRuntimeConfig = getUpdateNotifierRuntimeConfig();
const cli = createCli({ version: packageVersion });

async function main(): Promise<void> {
  const updateHintPromise = checkForUpdates({
    packageName,
    currentVersion: packageVersion,
    cacheTtlMs: updateRuntimeConfig.cacheTtlMs,
    fetchTimeoutMs: updateRuntimeConfig.fetchTimeoutMs,
  });

  try {
    await cli.parseAsync(process.argv);
  } finally {
    const updateHint = await updateHintPromise;

    if (updateHint) {
      console.error(updateHint);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
