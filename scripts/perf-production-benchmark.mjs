import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const llmEntryPath = path.join(repoRoot, 'dist', 'index.js');

const SCENARIOS = ['claude', 'codex'];
const BENCHMARK_TIMEZONE = 'UTC';

// Both tools are warmed with a LIVE run so pricing caches actually populate, then
// their timed application-warm cells read those caches offline. Update-check suppression is
// asymmetric and unavoidable: llm-usage gets LLM_USAGE_SKIP_UPDATE_CHECK=1 on every
// invocation, but ccusage exposes no equivalent flag or env (verified via
// `ccusage --help`) — it is a native binary with no npm-style launch-time update
// check, so there is no knob to match.
const METHODOLOGY_LINES = [
  'Methodology:',
  '  - Application-warm setup: each tool is warmed once with a LIVE (online) run',
  '    so its pricing caches populate; timed repeat runs then read those caches offline',
  '    (ccusage --offline, llm-usage --pricing-offline).',
  '  - Application-cold cells are first runs with fresh XDG_CACHE_HOME and',
  '    XDG_CONFIG_HOME directories and live pricing. llm-usage also sets',
  '    LLM_USAGE_EVENT_STORE=0 so no prior parse state is reused.',
  '  - Application-warm cells are repeat runs with warmed application caches and',
  '    offline pricing. The OS filesystem page cache is not flushed for either cell.',
  '  - Both tools run with TZ=UTC and isolated config/cache paths. Inherited',
  '    LLM_USAGE_* overrides are removed before llm-usage benchmark commands run.',
  '  - Commands invoke the ccusage executable and Node dist entry directly; timing',
  '    excludes npm, npx, and pnpm launcher overhead.',
  '  - Source files must remain unchanged while the benchmark runs. Stop active',
  '    tools or point HOME at a stable snapshot of the source corpus.',
  '  - Update-check suppression: llm-usage gets LLM_USAGE_SKIP_UPDATE_CHECK=1 on',
  '    every invocation; ccusage exposes no equivalent flag or env, so none is',
  '    applied (verified via `ccusage --help`).',
];

function printHelp() {
  console.log(`Usage: node scripts/perf-production-benchmark.mjs [options]

Benchmark ccusage <source> daily vs llm-usage daily --source <source>, for
source in {claude, codex}. Each scenario times four cells over N runs:

  - ccusage application-cold  first run, fresh app cache/config, live pricing
  - ccusage application-warm  repeat run, warmed app cache, offline pricing
  - llm-usage application-cold  first run, fresh app cache/config, event store off, live pricing
  - llm-usage application-warm  repeat run, warmed app cache + event store, offline pricing

Each tool's application-warm cache home is populated by one live (online) warm-up
run before sampling. The OS filesystem page cache is not flushed.

Both tools are invoked directly, without npm/npx/pnpm launcher overhead. llm-usage
uses the freshly built dist (node dist/index.js), so it reflects the current
checkout. Build first: pnpm run build.

${METHODOLOGY_LINES.join('\n')}

Options:
  --runs <count>             Number of timed runs per cell (default: 8)
  --scenario <name>          claude | codex | all (default: all)
  --ccusage-bin <path>       Direct ccusage executable to benchmark (default: ccusage)
  --json-output <path>       Write detailed benchmark payload as JSON
  --markdown-output <path>   Write markdown benchmark summary
  --keep-temp-cache          Keep temporary cache directory for inspection
  -h, --help                 Show this help
`);
}

function parseCliArgs(argv) {
  const args = {
    runs: 8,
    scenario: 'all',
    ccusageBin: 'ccusage',
    jsonOutputPath: undefined,
    markdownOutputPath: undefined,
    keepTempCache: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      continue;
    }

    switch (arg) {
      case '--runs': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--runs requires a numeric value');
        }

        const parsedValue = Number.parseInt(value, 10);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
          throw new Error('--runs must be a positive integer');
        }

        args.runs = parsedValue;
        index += 1;
        break;
      }
      case '--scenario': {
        const value = argv[index + 1];

        if (!value || !['claude', 'codex', 'all'].includes(value)) {
          throw new Error('--scenario must be claude, codex, or all');
        }

        args.scenario = value;
        index += 1;
        break;
      }
      case '--ccusage-bin': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--ccusage-bin requires a path');
        }

        args.ccusageBin = value;
        index += 1;
        break;
      }
      case '--json-output': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--json-output requires a file path');
        }

        args.jsonOutputPath = value;
        index += 1;
        break;
      }
      case '--markdown-output': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--markdown-output requires a file path');
        }

        args.markdownOutputPath = value;
        index += 1;
        break;
      }
      case '--keep-temp-cache':
        args.keepTempCache = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        return args;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function runCommand(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  });

  if (result.error) {
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    throw new Error(`Failed to execute '${command}': ${reason}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `Command failed (${command} ${commandArgs.join(' ')}): ${stderr || `exit code ${result.status}`}`,
    );
  }

  return (result.stdout ?? '').trim();
}

function buildBenchmarkEnv(overrides) {
  const env = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (
      !name.startsWith('LLM_USAGE_') &&
      name !== 'CODEX_HOME' &&
      name !== 'CLAUDE_CONFIG_DIR' &&
      value !== undefined
    ) {
      env[name] = value;
    }
  }

  return {
    ...env,
    TZ: BENCHMARK_TIMEZONE,
    CODEX_HOME: path.join(os.homedir(), '.codex'),
    CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'),
    ...overrides,
  };
}

function buildLlmBenchmarkEnv({ cacheRoot, configRoot, eventStorePath }) {
  const eventStoreEnv = eventStorePath
    ? {
        LLM_USAGE_EVENT_STORE: '1',
        LLM_USAGE_EVENT_STORE_PATH: eventStorePath,
      }
    : { LLM_USAGE_EVENT_STORE: '0' };

  return buildBenchmarkEnv({
    XDG_CACHE_HOME: cacheRoot,
    XDG_CONFIG_HOME: configRoot,
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    ...eventStoreEnv,
  });
}

function assertCommandAvailable(command) {
  try {
    runCommand(command, ['--version']);
  } catch (error) {
    throw new Error(
      `Required command '${command}' is not available. Install it before running this benchmark.`,
      { cause: error },
    );
  }
}

// Fail early and name the missing piece rather than crash mid-run.
function assertToolchainAvailable(cliArgs) {
  if (!existsSync(llmEntryPath)) {
    throw new Error(`Built CLI not found at ${llmEntryPath}. Run 'pnpm run build' first.`);
  }

  assertCommandAvailable(cliArgs.ccusageBin);
  assertCommandAvailable('pnpm');
}

function measureCommand(command, commandArgs, options = {}) {
  const startedAt = process.hrtime.bigint();
  runCommand(command, commandArgs, options);
  const elapsedNs = process.hrtime.bigint() - startedAt;
  return Number(elapsedNs) / 1_000_000;
}

function summarize(valuesMs) {
  const sorted = [...valuesMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  return {
    runs: sorted.length,
    minMs: sorted[0],
    medianMs,
    meanMs,
    maxMs: sorted[sorted.length - 1],
  };
}

function toSeconds(valueMs) {
  return Number((valueMs / 1_000).toFixed(3));
}

function toFixed(value, digits = 2) {
  return Number(value.toFixed(digits));
}

// ccusage <source> daily [--offline|--no-offline] --json
function ccusageArgs(source, offline) {
  return [
    source,
    'daily',
    offline ? '--offline' : '--no-offline',
    '--timezone',
    BENCHMARK_TIMEZONE,
    '--json',
  ];
}

// node dist/index.js daily --source <source> [--pricing-offline] --json
function llmArgs(source, pricingOffline) {
  const args = [
    llmEntryPath,
    'daily',
    '--source',
    source,
    '--timezone',
    BENCHMARK_TIMEZONE,
    '--json',
  ];

  if (pricingOffline) {
    args.push('--pricing-offline');
  }

  return args;
}

function toScenarioTableRows(sourceResult, ccusageBinLabel) {
  return [
    {
      Tool: `${ccusageBinLabel} ${ccusageArgs(sourceResult.source, false).join(' ')}`,
      State: 'fresh application state',
      stats: sourceResult.summary.ccusageCold,
    },
    {
      Tool: `${ccusageBinLabel} ${ccusageArgs(sourceResult.source, true).join(' ')}`,
      State: 'warmed application state',
      stats: sourceResult.summary.ccusageWarm,
    },
    {
      Tool: `llm-usage ${llmArgs(sourceResult.source, false).slice(1).join(' ')}`,
      State: 'fresh application state',
      stats: sourceResult.summary.llmCold,
    },
    {
      Tool: `llm-usage ${llmArgs(sourceResult.source, true).slice(1).join(' ')}`,
      State: 'warmed application state',
      stats: sourceResult.summary.llmWarm,
    },
  ].map((row) => ({
    Tool: row.Tool,
    State: row.State,
    'Median (s)': toSeconds(row.stats.medianMs),
    'Mean (s)': toSeconds(row.stats.meanMs),
    'Min (s)': toSeconds(row.stats.minMs),
    'Max (s)': toSeconds(row.stats.maxMs),
  }));
}

function describeMedianWinner(llmMedianMs, ccusageMedianMs) {
  if (llmMedianMs === ccusageMedianMs) {
    return 'llm-usage and ccusage have the same median runtime';
  }

  const llmUsageWins = llmMedianMs < ccusageMedianMs;
  const winner = llmUsageWins ? 'llm-usage' : 'ccusage';
  const loser = llmUsageWins ? 'ccusage' : 'llm-usage';
  const multiplier = llmUsageWins ? ccusageMedianMs / llmMedianMs : llmMedianMs / ccusageMedianMs;

  return `${winner} is ${multiplier.toFixed(2)}x faster than ${loser}`;
}

function buildMarkdownSummary(report) {
  const specs = report.machine;
  const lines = [
    `## Production benchmark (${report.generatedAt})`,
    '',
    '### Baseline machine',
    '',
    '| Spec | Value |',
    '| --- | --- |',
    `| OS | ${specs.os} |`,
    `| CPU | ${specs.cpuModel} (${specs.logicalCpus} logical CPUs) |`,
    `| Memory | ${specs.totalMemoryGiB} GiB RAM |`,
    `| Node.js | ${specs.nodeVersion} |`,
    `| pnpm | ${specs.pnpmVersion} |`,
    `| ccusage | ${specs.ccusageVersion} |`,
    `| llm-usage | ${specs.llmUsageVersion} (git ${specs.llmUsageGitHead}) |`,
  ];

  for (const sourceResult of report.resultsBySource) {
    const rows = toScenarioTableRows(sourceResult, report.config.ccusageBinLabel);
    const summary = sourceResult.summary;

    lines.push(
      '',
      `### ${sourceResult.source} — daily (${report.config.runs} runs each)`,
      '',
      '| Tool | State | Median (s) | Mean (s) | Min (s) | Max (s) |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      ...rows.map(
        (row) =>
          `| \`${row.Tool}\` | ${row.State} | ${row['Median (s)']} | ${row['Mean (s)']} | ${row['Min (s)']} | ${row['Max (s)']} |`,
      ),
      '',
      'Derived from median runtime:',
      '',
      `- Application-cold (first run): ${describeMedianWinner(summary.llmCold.medianMs, summary.ccusageCold.medianMs)}.`,
      `- Application-warm (repeat run): ${describeMedianWinner(summary.llmWarm.medianMs, summary.ccusageWarm.medianMs)}.`,
    );
  }

  return `${lines.join('\n')}\n`;
}

async function writeOutputFile(filePath, content) {
  const resolvedFilePath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedFilePath), { recursive: true });
  await writeFile(resolvedFilePath, content, 'utf8');
  return resolvedFilePath;
}

function resolveMachineSpecs(ccusageBin) {
  const cpu = os.cpus()?.[0];

  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: cpu?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalMemoryGiB: toFixed(os.totalmem() / 1024 ** 3, 1),
    nodeVersion: process.version,
    pnpmVersion: runCommand('pnpm', ['-v']),
    ccusageVersion: runCommand(ccusageBin, ['--version']),
    llmUsageVersion: runCommand(process.execPath, [llmEntryPath, '--version']),
    llmUsageGitHead: runCommand('git', ['rev-parse', '--short', 'HEAD']),
  };
}

async function benchmarkSource(source, cliArgs, tempCacheRoot) {
  const ccusageBin = cliArgs.ccusageBin;
  const warmCcusageCacheRoot = path.join(tempCacheRoot, 'cache', 'warm', `ccusage-${source}`);
  const warmCcusageConfigRoot = path.join(tempCacheRoot, 'config', 'warm', `ccusage-${source}`);
  const warmLlmCacheRoot = path.join(tempCacheRoot, 'cache', 'warm', `llm-${source}`);
  const warmLlmConfigRoot = path.join(tempCacheRoot, 'config', 'warm', `llm-${source}`);
  const warmLlmEventStorePath = path.join(warmLlmCacheRoot, 'events.sqlite');

  await mkdir(warmCcusageCacheRoot, { recursive: true });
  await mkdir(warmCcusageConfigRoot, { recursive: true });
  await mkdir(warmLlmCacheRoot, { recursive: true });
  await mkdir(warmLlmConfigRoot, { recursive: true });

  // Warm each tool's cache with one LIVE (online) run before sampling, so the
  // timed warm cells read a genuinely populated cache on both sides.
  runCommand(ccusageBin, ccusageArgs(source, false), {
    env: buildBenchmarkEnv({
      XDG_CACHE_HOME: warmCcusageCacheRoot,
      XDG_CONFIG_HOME: warmCcusageConfigRoot,
    }),
  });
  // ccusage has no update-check/telemetry env to suppress; llm-usage gets its own.
  runCommand(process.execPath, llmArgs(source, false), {
    env: buildLlmBenchmarkEnv({
      cacheRoot: warmLlmCacheRoot,
      configRoot: warmLlmConfigRoot,
      eventStorePath: warmLlmEventStorePath,
    }),
  });

  const timings = { ccusageCold: [], ccusageWarm: [], llmCold: [], llmWarm: [] };
  const executionOrderByRun = [];

  for (let runIndex = 1; runIndex <= cliArgs.runs; runIndex += 1) {
    const coldCcusageCacheRoot = path.join(
      tempCacheRoot,
      'cache',
      `run-${runIndex}`,
      `ccusage-${source}`,
    );
    const coldCcusageConfigRoot = path.join(
      tempCacheRoot,
      'config',
      `run-${runIndex}`,
      `ccusage-${source}`,
    );
    const coldLlmCacheRoot = path.join(tempCacheRoot, 'cache', `run-${runIndex}`, `llm-${source}`);
    const coldLlmConfigRoot = path.join(
      tempCacheRoot,
      'config',
      `run-${runIndex}`,
      `llm-${source}`,
    );

    await mkdir(coldCcusageCacheRoot, { recursive: true });
    await mkdir(coldCcusageConfigRoot, { recursive: true });
    await mkdir(coldLlmCacheRoot, { recursive: true });
    await mkdir(coldLlmConfigRoot, { recursive: true });

    const cells = [
      {
        name: 'ccusageCold',
        measure: () =>
          measureCommand(ccusageBin, ccusageArgs(source, false), {
            env: buildBenchmarkEnv({
              XDG_CACHE_HOME: coldCcusageCacheRoot,
              XDG_CONFIG_HOME: coldCcusageConfigRoot,
            }),
          }),
      },
      {
        name: 'ccusageWarm',
        measure: () =>
          measureCommand(ccusageBin, ccusageArgs(source, true), {
            env: buildBenchmarkEnv({
              XDG_CACHE_HOME: warmCcusageCacheRoot,
              XDG_CONFIG_HOME: warmCcusageConfigRoot,
            }),
          }),
      },
      {
        name: 'llmCold',
        measure: () =>
          measureCommand(process.execPath, llmArgs(source, false), {
            env: buildLlmBenchmarkEnv({
              cacheRoot: coldLlmCacheRoot,
              configRoot: coldLlmConfigRoot,
            }),
          }),
      },
      {
        name: 'llmWarm',
        measure: () =>
          measureCommand(process.execPath, llmArgs(source, true), {
            env: buildLlmBenchmarkEnv({
              cacheRoot: warmLlmCacheRoot,
              configRoot: warmLlmConfigRoot,
              eventStorePath: warmLlmEventStorePath,
            }),
          }),
      },
    ];
    const executionOrder = rotateForRun(cells, runIndex);

    executionOrderByRun.push({
      run: runIndex,
      cells: executionOrder.map((cell) => cell.name),
    });

    for (const cell of executionOrder) {
      timings[cell.name].push(cell.measure());
    }
  }

  const summary = {
    ccusageCold: summarize(timings.ccusageCold),
    ccusageWarm: summarize(timings.ccusageWarm),
    llmCold: summarize(timings.llmCold),
    llmWarm: summarize(timings.llmWarm),
  };

  const derivedSpeedups = {
    llmVsCcusageCold: toFixed(summary.ccusageCold.medianMs / summary.llmCold.medianMs),
    llmVsCcusageWarm: toFixed(summary.ccusageWarm.medianMs / summary.llmWarm.medianMs),
  };

  return { source, timings, summary, derivedSpeedups, executionOrderByRun };
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  assertToolchainAvailable(cliArgs);
  const sources = cliArgs.scenario === 'all' ? SCENARIOS : [cliArgs.scenario];
  // Published tables always name the competitor "ccusage", not the resolved bin path.
  const ccusageBinLabel = 'ccusage';

  console.log(METHODOLOGY_LINES.join('\n'));

  const tempCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-prod-benchmark-'));
  const resultsBySource = [];

  try {
    for (const source of sources) {
      resultsBySource.push(await benchmarkSource(source, cliArgs, tempCacheRoot));
    }
  } finally {
    if (!cliArgs.keepTempCache) {
      await rm(tempCacheRoot, { recursive: true, force: true });
    }
  }

  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    config: {
      runs: cliArgs.runs,
      scenario: cliArgs.scenario,
      timezone: BENCHMARK_TIMEZONE,
      ccusageBinLabel,
      includesNpmLauncherOverhead: false,
    },
    machine: resolveMachineSpecs(cliArgs.ccusageBin),
    resultsBySource,
  };

  console.log('Production benchmark summary');
  for (const sourceResult of resultsBySource) {
    console.log(`\n${sourceResult.source} — daily`);
    console.table(toScenarioTableRows(sourceResult, ccusageBinLabel));
    console.log(
      `- Application-cold (first run): ${describeMedianWinner(sourceResult.summary.llmCold.medianMs, sourceResult.summary.ccusageCold.medianMs)}.`,
    );
    console.log(
      `- Application-warm (repeat run): ${describeMedianWinner(sourceResult.summary.llmWarm.medianMs, sourceResult.summary.ccusageWarm.medianMs)}.`,
    );
  }

  if (cliArgs.jsonOutputPath) {
    const outputPath = await writeOutputFile(
      cliArgs.jsonOutputPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`Wrote JSON benchmark report: ${outputPath}`);
  }

  if (cliArgs.markdownOutputPath) {
    const outputPath = await writeOutputFile(
      cliArgs.markdownOutputPath,
      buildMarkdownSummary(report),
    );
    console.log(`Wrote markdown benchmark summary: ${outputPath}`);
  }
}

function rotateForRun(cells, runIndex) {
  const rotationIndex = (runIndex - 1) % cells.length;
  return [...cells.slice(rotationIndex), ...cells.slice(0, rotationIndex)];
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await main();
}

export { buildBenchmarkEnv, buildLlmBenchmarkEnv, ccusageArgs, llmArgs, rotateForRun };
