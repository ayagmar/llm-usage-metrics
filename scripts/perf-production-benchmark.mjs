import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const llmEntryPath = path.join(repoRoot, 'dist', 'index.js');

const SCENARIOS = ['claude', 'codex'];

function printHelp() {
  console.log(`Usage: node scripts/perf-production-benchmark.mjs [options]

Benchmark ccusage <source> daily vs llm-usage daily --source <source>, for
source in {claude, codex}. Each scenario times four cells over N runs:

  - ccusage cold    ccusage <source> daily --no-offline --json (fresh cache home)
  - ccusage warm    ccusage <source> daily --offline    --json (warmed cache home)
  - llm-usage cold  daily --source <source> --json       (fresh cache home, event store off, live pricing)
  - llm-usage warm  daily --source <source> --pricing-offline --json (warmed cache home + event store)

llm-usage is measured via the freshly built dist (node dist/index.js), so it
reflects the current checkout. Build first: pnpm run build.

Options:
  --runs <count>             Number of timed runs per cell (default: 5)
  --scenario <name>          claude | codex | all (default: all)
  --ccusage-bin <path>       ccusage executable to benchmark (default: ccusage)
  --json-output <path>       Write detailed benchmark payload as JSON
  --markdown-output <path>   Write markdown benchmark summary
  --keep-temp-cache          Keep temporary cache directory for inspection
  -h, --help                 Show this help
`);
}

function parseCliArgs(argv) {
  const args = {
    runs: 5,
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
    env: {
      ...process.env,
      ...options.env,
    },
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
  return [source, 'daily', offline ? '--offline' : '--no-offline', '--json'];
}

// node dist/index.js daily --source <source> [--pricing-offline] --json
function llmArgs(source, pricingOffline) {
  const args = [llmEntryPath, 'daily', '--source', source, '--json'];

  if (pricingOffline) {
    args.push('--pricing-offline');
  }

  return args;
}

function toScenarioTableRows(sourceResult, ccusageBinLabel) {
  return [
    {
      Tool: `${ccusageBinLabel} ${sourceResult.source} daily`,
      Cache: 'cold',
      stats: sourceResult.summary.ccusageCold,
    },
    {
      Tool: `${ccusageBinLabel} ${sourceResult.source} daily --offline`,
      Cache: 'warm',
      stats: sourceResult.summary.ccusageWarm,
    },
    {
      Tool: `llm-usage daily --source ${sourceResult.source}`,
      Cache: 'cold',
      stats: sourceResult.summary.llmCold,
    },
    {
      Tool: `llm-usage daily --source ${sourceResult.source} --pricing-offline`,
      Cache: 'warm',
      stats: sourceResult.summary.llmWarm,
    },
  ].map((row) => ({
    Tool: row.Tool,
    Cache: row.Cache,
    'Median (s)': toSeconds(row.stats.medianMs),
    'Mean (s)': toSeconds(row.stats.meanMs),
    'Min (s)': toSeconds(row.stats.minMs),
    'Max (s)': toSeconds(row.stats.maxMs),
  }));
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
    const speedups = sourceResult.derivedSpeedups;

    lines.push(
      '',
      `### ${sourceResult.source} — daily (${report.config.runs} runs each)`,
      '',
      '| Tool | Cache | Median (s) | Mean (s) | Min (s) | Max (s) |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      ...rows.map(
        (row) =>
          `| \`${row.Tool}\` | ${row.Cache} | ${row['Median (s)']} | ${row['Mean (s)']} | ${row['Min (s)']} | ${row['Max (s)']} |`,
      ),
      '',
      'Derived from median runtime:',
      '',
      `- \`llm-usage\` vs \`ccusage\` (cold): \`${speedups.llmVsCcusageCold}x\``,
      `- \`llm-usage\` vs \`ccusage\` (warm): \`${speedups.llmVsCcusageWarm}x\``,
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
  const warmCcusageRoot = path.join(tempCacheRoot, 'warm', `ccusage-${source}`);
  const warmLlmRoot = path.join(tempCacheRoot, 'warm', `llm-${source}`);

  await mkdir(warmCcusageRoot, { recursive: true });
  await mkdir(warmLlmRoot, { recursive: true });

  // Warm the shared caches once before sampling.
  runCommand(ccusageBin, ccusageArgs(source, true), {
    env: { XDG_CACHE_HOME: warmCcusageRoot },
  });
  runCommand(process.execPath, llmArgs(source, false), {
    env: { XDG_CACHE_HOME: warmLlmRoot, LLM_USAGE_SKIP_UPDATE_CHECK: '1' },
  });

  const timings = { ccusageCold: [], ccusageWarm: [], llmCold: [], llmWarm: [] };

  for (let runIndex = 1; runIndex <= cliArgs.runs; runIndex += 1) {
    const coldCcusageRoot = path.join(tempCacheRoot, `run-${runIndex}`, `ccusage-${source}`);
    const coldLlmRoot = path.join(tempCacheRoot, `run-${runIndex}`, `llm-${source}`);

    await mkdir(coldCcusageRoot, { recursive: true });
    await mkdir(coldLlmRoot, { recursive: true });

    timings.ccusageCold.push(
      measureCommand(ccusageBin, ccusageArgs(source, false), {
        env: { XDG_CACHE_HOME: coldCcusageRoot },
      }),
    );
    timings.ccusageWarm.push(
      measureCommand(ccusageBin, ccusageArgs(source, true), {
        env: { XDG_CACHE_HOME: warmCcusageRoot },
      }),
    );
    timings.llmCold.push(
      measureCommand(process.execPath, llmArgs(source, false), {
        env: {
          XDG_CACHE_HOME: coldLlmRoot,
          LLM_USAGE_EVENT_STORE: '0',
          LLM_USAGE_SKIP_UPDATE_CHECK: '1',
        },
      }),
    );
    timings.llmWarm.push(
      measureCommand(process.execPath, llmArgs(source, true), {
        env: { XDG_CACHE_HOME: warmLlmRoot, LLM_USAGE_SKIP_UPDATE_CHECK: '1' },
      }),
    );
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

  return { source, timings, summary, derivedSpeedups };
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const sources = cliArgs.scenario === 'all' ? SCENARIOS : [cliArgs.scenario];
  // Published tables always name the competitor "ccusage", not the resolved bin path.
  const ccusageBinLabel = 'ccusage';

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
    config: { runs: cliArgs.runs, scenario: cliArgs.scenario, ccusageBinLabel },
    machine: resolveMachineSpecs(cliArgs.ccusageBin),
    resultsBySource,
  };

  console.log('Production benchmark summary');
  for (const sourceResult of resultsBySource) {
    console.log(`\n${sourceResult.source} — daily`);
    console.table(toScenarioTableRows(sourceResult, ccusageBinLabel));
    console.log(
      `- llm-usage vs ccusage (cold): ${sourceResult.derivedSpeedups.llmVsCcusageCold.toFixed(2)}x`,
    );
    console.log(
      `- llm-usage vs ccusage (warm): ${sourceResult.derivedSpeedups.llmVsCcusageWarm.toFixed(2)}x`,
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

await main();
