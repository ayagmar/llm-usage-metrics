// Headless Chromium for the docs scripts, through playwright-core (which downloads no
// browser on install). Uses PLAYWRIGHT_CHROMIUM_EXECUTABLE when set, else the Chromium that
// Playwright installed for this playwright-core version.

import { existsSync } from 'node:fs';

import { chromium } from 'playwright-core';

export function resolveChromiumExecutable(env = process.env) {
  const fromEnv = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE points to a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }

  const installed = chromium.executablePath();
  if (existsSync(installed)) return installed;

  throw new Error(
    [
      'No Chromium found for the docs screenshots. Either:',
      '  - set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium or chrome-headless-shell binary, or',
      '  - install the Chromium this playwright-core expects:',
      '      pnpm --filter llm-usage-metrics-site exec playwright-core install chromium',
      `(looked for ${installed})`,
    ].join('\n'),
  );
}

/** Launches headless Chromium; close it with `browser.close()`. */
export async function launchChromium() {
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch({ executablePath, headless: true });
  return { browser, executablePath };
}
