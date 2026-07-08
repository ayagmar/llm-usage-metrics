#!/usr/bin/env node

import { getUpdateNotifierRuntimeConfig } from '../config/runtime-overrides.js';
import { loadUserConfig } from '../config/user-config.js';
import { checkForUpdates } from '../update/update-notifier.js';
import { createCli } from './create-cli.js';
import { loadPackageMetadataFromRuntime } from './package-metadata.js';

const { packageName, packageVersion } = loadPackageMetadataFromRuntime();
const cli = createCli({ version: packageVersion });

async function main(): Promise<void> {
  const loadedConfig = await loadUserConfig();
  const updateRuntimeConfig = getUpdateNotifierRuntimeConfig(process.env, loadedConfig.config);
  const updateHintPromise = checkForUpdates({
    packageName,
    currentVersion: packageVersion,
    skipCheck: updateRuntimeConfig.skipCheck,
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
