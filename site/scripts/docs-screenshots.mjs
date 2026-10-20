// Regenerates the docs screenshots and the landing page's demo report from synthetic data:
//   pnpm run build && pnpm run docs:screenshots
// Writes webp images to site/src/assets/screenshots/ and the interactive report to
// site/public/demo/report.html. The CLI runs with a temp HOME holding the demo logs, a missing
// config file, offline pricing and --no-sync, so nothing reads or writes real user state.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';

import sharp from 'sharp';

import { DEMO_DAYS, DEMO_SOURCES, writeDemoData } from './demo-data.mjs';
import { ansiToHtml, escapeHtml } from './lib/ansi-to-html.mjs';
import { launchChromium } from './lib/browser.mjs';

const execFileAsync = promisify(execFile);

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.dirname(siteRoot);
const cliPath = path.join(repoRoot, 'dist', 'index.js');
const screenshotsDir = path.join(siteRoot, 'src', 'assets', 'screenshots');
const demoReportPath = path.join(siteRoot, 'public', 'demo', 'report.html');

const COLUMNS = 120;
const TIMEZONE = 'UTC';
const WEBP_QUALITY = 86;

// The CLI reads its width from a TTY stdout and ignores COLUMNS when piped, so each
// capture runs with stdout reporting itself as a COLUMNS-wide terminal.
const TERMINAL_PRELOAD = `data:text/javascript,process.stdout.isTTY=true;process.stdout.columns=${COLUMNS};`;

// Flags every report command gets: the demo window, offline pricing, no machine sync.
const REPORT_FLAGS = ['--timezone', TIMEZONE, '--pricing-offline', '--no-sync'];

/**
 * Terminal screenshots. `args` is what the image's title bar shows; `flags` says which demo
 * flags the command accepts (`report`: sources + REPORT_FLAGS, `sources`: source flags only,
 * `none`: nothing added) and `extra` adds flags that are not shown.
 */
const TERMINAL_SHOTS = [
  { name: 'term-summary', args: ['summary'], flags: 'report' },
  { name: 'term-daily', args: ['daily', '--last', '3'], flags: 'report' },
  { name: 'term-hourly', args: ['hourly', '--compact'], flags: 'report' },
  { name: 'term-projects', args: ['projects'], flags: 'report' },
  { name: 'term-compare', args: ['compare'], flags: 'report' },
  { name: 'term-session', args: ['session', '--top', '5'], flags: 'report' },
  { name: 'term-trends', args: ['trends'], flags: 'report' },
  { name: 'term-blocks', args: ['blocks', '--last', '2', '--compact'], flags: 'report' },
  { name: 'term-value', args: ['value'], flags: 'report' },
  {
    name: 'term-pricing',
    args: ['pricing', 'claude-sonnet-4-5'],
    flags: 'none',
    extra: ['--pricing-offline'],
  },
  {
    name: 'term-statusline',
    args: ['statusline'],
    flags: 'sources',
    extra: ['--timezone', TIMEZONE],
  },
  { name: 'term-wrapped', args: ['wrapped'], flags: 'report' },
  { name: 'term-doctor', args: ['doctor'], flags: 'sources' },
];

// What a report prints when the demo data has no usage for it; a shot showing one is wrong.
const EMPTY_OUTPUT_MARKERS = ['No usage data found', '$0.00 today'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** An environment with nothing from the user's: the temp HOME, a missing config, colour on. */
function createCliEnv(home, configPath) {
  return {
    PATH: process.env.PATH ?? '',
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot ?? '', USERPROFILE: home }
      : {}),
    HOME: home,
    LLM_USAGE_CONFIG_PATH: configPath,
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    FORCE_COLOR: '1',
    TZ: TIMEZONE,
  };
}

function sourceFlags(dirs) {
  return [
    '--source',
    DEMO_SOURCES.join(','),
    ...DEMO_SOURCES.flatMap((source) => ['--source-dir', `${source}=${dirs[source]}`]),
  ];
}

async function runCli(args, { env, cwd }) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', TERMINAL_PRELOAD, cliPath, ...args],
      {
        env,
        cwd,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (stdout.trim() === '') throw new Error('empty stdout');
    return stdout;
  } catch (error) {
    const detail = error.stderr ? `\n${error.stderr}` : '';
    throw new Error(`llm-usage ${args.join(' ')} failed: ${error.message}${detail}`);
  }
}

function terminalPage(command, ansi) {
  const body = ansiToHtml(ansi.replace(/\n+$/u, ''));
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  .terminal {
    display: inline-block; margin: 0; border-radius: 10px; overflow: hidden;
    background: #16181d; border: 1px solid #2b2f37;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
  }
  .bar {
    display: flex; align-items: center; gap: 7px; padding: 10px 14px;
    background: #1d2027; border-bottom: 1px solid #2b2f37;
  }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #3a3f4a; }
  pre, .prompt {
    font-family: 'JetBrains Mono', 'JetBrainsMono Nerd Font Mono', 'Geist Mono', 'SFMono-Regular',
      'DejaVu Sans Mono', 'Menlo', 'Consolas', monospace;
    font-size: 14px; line-height: 1.25; color: #d4d4d4;
  }
  .prompt { padding: 14px 18px 0; }
  .prompt b { color: #98c379; font-weight: 400; }
  pre { margin: 0; padding: 8px 18px 16px; font-variant-ligatures: none; }
</style></head><body>
<div class="terminal">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <div class="prompt"><b>$</b> ${escapeHtml(command)}</div>
  <pre>${body}</pre>
</div>
</body></html>`;
}

async function writeWebp(name, png) {
  const file = path.join(screenshotsDir, `${name}.webp`);
  await sharp(png).webp({ quality: WEBP_QUALITY }).toFile(file);
  console.log(`  ${path.relative(repoRoot, file)}`);
}

async function shootTerminals(browser, { env, cwd, dirs }) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  });

  for (const shot of TERMINAL_SHOTS) {
    const added =
      shot.flags === 'report'
        ? [...sourceFlags(dirs), ...REPORT_FLAGS]
        : shot.flags === 'sources'
          ? sourceFlags(dirs)
          : [];
    const ansi = await runCli([...shot.args, ...added, ...(shot.extra ?? [])], { env, cwd });
    const text = stripVTControlCharacters(ansi);
    const marker = EMPTY_OUTPUT_MARKERS.find((value) => text.includes(value));
    if (marker)
      throw new Error(`llm-usage ${shot.args.join(' ')} printed "${marker}" for the demo data`);
    await page.setContent(terminalPage(`llm-usage ${shot.args.join(' ')}`, ansi));
    await page.evaluate(() => document.fonts.ready);
    const png = await page.locator('.terminal').screenshot({ omitBackground: true });
    await writeWebp(shot.name, png);
  }

  await page.close();
}

/** Opens the report in a fresh context with the given colour scheme and viewport. */
async function openReport(browser, url, { colorScheme, width, height, scale }) {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width, height },
    deviceScaleFactor: scale,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForLoadState('load');
  await page.waitForSelector('svg');
  await page.evaluate(() => document.fonts.ready);
  return { context, page };
}

/** A screenshot of one element with `margin` px of the page around it. */
async function screenshotWithMargin(page, selector, margin) {
  const element = page.locator(selector);
  await element.scrollIntoViewIfNeeded();
  const box = await element.boundingBox();
  if (box === null) throw new Error(`${selector} is not visible in the report`);
  const viewport = page.viewportSize();
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  return page.screenshot({
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + 2 * margin),
      height: Math.min(viewport.height - y, box.height + 2 * margin),
    },
  });
}

async function shootReport(browser, reportFile) {
  const url = pathToFileURL(reportFile).href;

  for (const colorScheme of ['light', 'dark']) {
    const daily = await openReport(browser, url, {
      colorScheme,
      width: 1440,
      height: 1000,
      scale: 1,
    });
    await writeWebp(`share-daily-${colorScheme}`, await daily.page.screenshot());
    await daily.context.close();

    // The project table at the foot of the report.
    const projects = await openReport(browser, url, {
      colorScheme,
      width: 1440,
      height: 1000,
      scale: 1,
    });
    await writeWebp(
      `share-projects-${colorScheme}`,
      await screenshotWithMargin(projects.page, '.table-section', 24),
    );
    await projects.context.close();
  }

  const mobile = await openReport(browser, url, {
    colorScheme: 'dark',
    width: 375,
    height: 812,
    scale: 2,
  });
  // Phones open on the controls; show the totals and the first chart below them.
  await mobile.page.locator('#main').evaluate((element) => element.scrollIntoView());
  await writeWebp('share-mobile-dark', await mobile.page.screenshot());
  await mobile.context.close();
}

async function main() {
  if (!existsSync(cliPath)) fail(`No built CLI at ${cliPath}. Run \`pnpm run build\` first.`);

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-docs-'));
  const home = path.join(scratch, 'home');
  const outDir = path.join(scratch, 'out');
  const configPath = path.join(scratch, 'missing-config.toml');
  const now = Date.now();

  try {
    await mkdir(outDir, { recursive: true });
    const { dirs, fileCount } = await writeDemoData({ home, now });
    console.log(`Demo data: ${fileCount} files up to ${new Date(now).toISOString()}`);
    const env = createCliEnv(home, configPath);

    const { browser, executablePath } = await launchChromium();
    console.log(`Chromium: ${executablePath}`);

    try {
      await mkdir(screenshotsDir, { recursive: true });
      await shootTerminals(browser, { env, cwd: outDir, dirs });

      // The demo report opens on the whole 90-day window.
      await runCli(
        [
          'daily',
          '--last',
          String(DEMO_DAYS),
          '--share',
          '--no-open',
          ...sourceFlags(dirs),
          ...REPORT_FLAGS,
        ],
        {
          env,
          cwd: outDir,
        },
      );
      const [reportName] = (await readdir(outDir)).filter((file) => file.endsWith('.html'));
      if (!reportName) throw new Error('daily --share wrote no HTML report');
      const reportFile = path.join(outDir, reportName);
      await shootReport(browser, reportFile);

      await mkdir(path.dirname(demoReportPath), { recursive: true });
      await copyFile(reportFile, demoReportPath);
      console.log(`  ${path.relative(repoRoot, demoReportPath)}`);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
