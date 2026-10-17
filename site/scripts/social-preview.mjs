// Renders site/social-preview/social-preview.html to site/public/og.png (1200x630, also the
// GitHub social preview):
//   pnpm run build && node site/scripts/social-preview.mjs
// The source count on the image comes from the built CLI's --help, run with a temp HOME and a
// missing config file so nothing reads real user state.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { launchChromium } from './lib/browser.mjs';

const execFileAsync = promisify(execFile);

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.dirname(siteRoot);
const cliPath = path.join(repoRoot, 'dist', 'index.js');
const pagePath = path.join(siteRoot, 'social-preview', 'social-preview.html');
const outputPath = path.join(siteRoot, 'public', 'og.png');
const WIDTH = 1200;
const HEIGHT = 630;

async function readSourceCount() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-og-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help'], {
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot ?? '', USERPROFILE: home }
          : {}),
        HOME: home,
        LLM_USAGE_CONFIG_PATH: path.join(home, 'missing-config.toml'),
        LLM_USAGE_SKIP_UPDATE_CHECK: '1',
      },
    });
    const match = /Supported sources \((\d+)\)/u.exec(stdout);
    if (!match) throw new Error('llm-usage --help printed no "Supported sources (N)" line');
    return Number(match[1]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (!existsSync(cliPath)) {
  console.error(`Missing ${path.relative(repoRoot, cliPath)}: run pnpm run build first.`);
  process.exit(1);
}

const sourceCount = await readSourceCount();
const { browser, executablePath } = await launchChromium();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.goto(pathToFileURL(pagePath).href, { waitUntil: 'networkidle' });
  const filled = await page.evaluate((count) => {
    const slots = document.querySelectorAll('[data-source-count]');
    for (const slot of slots) slot.textContent = String(count);
    return slots.length;
  }, sourceCount);
  if (filled === 0) throw new Error('social-preview.html has no [data-source-count] element');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outputPath });
  console.log(
    `Wrote ${path.relative(repoRoot, outputPath)} (${sourceCount} sources) with ${executablePath}`,
  );
} finally {
  await browser.close();
}
