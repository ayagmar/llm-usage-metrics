import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function printHelp() {
  console.log(`Usage: node scripts/perf-production-benchmark.mjs [options]

Benchmark ccusage-codex monthly vs llm-usage monthly --provider openai.

Options:
  --runs <count>             Number of timed runs per scenario (default: 5)
  --llm-source <value>       Optional llm-usage source filter (single or comma-separated)
  --json-output <path>       Write detailed benchmark payload as JSON
  --markdown-output <path>   Write markdown benchmark summary
  --keep-temp-cache          Keep temporary cache directory for inspection
  -h, --help                 Show this help
`);
}

function parseCliArgs(argv) {
  const args = {
    runs: 5,
    llmSource: undefined,
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
      case '--json-output': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--json-output requires a file path');
        }

        args.jsonOutputPath = value;
        index += 1;
        break;
      }
      case '--llm-source': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--llm-source requires a value');
        }

        args.llmSource = value;
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
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
      `Command failed (${command} ${args.join(' ')}): ${stderr || `exit code ${result.status}`}`,
    );
  }

  return (result.stdout ?? '').trim();
}

function assertCommandAvailable(command) {
  try {
    runCommand(command, ['--version']);
  } catch (error) {
    throw new Error(
      `Required command '${command}' is not available. Install it before running this benchmark.`,
      {
        cause: error,
      },
    );
  }
}

function measureCommand(command, args, options = {}) {
  const startedAt = process.hrtime.bigint();
  runCommand(command, args, options);
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

function buildLlmUsageArgs(llmSource, includePricingOffline = false) {
  const args = ['monthly', '--provider', 'openai'];

  if (llmSource) {
    args.push('--source', llmSource);
  }

  if (includePricingOffline) {
    args.push('--pricing-offline');
  }

  args.push('--json');
  return args;
}

function buildLlmUsageToolName(llmSource, includePricingOffline = false) {
  const parts = ['llm-usage monthly --provider openai'];

  if (llmSource) {
    parts.push(`--source ${llmSource}`);
  }

  if (includePricingOffline) {
    parts.push('--pricing-offline');
  }

  return parts.join(' ');
}

function toTableRows(summaryByScenario, config) {
  const definitions = [
    { key: 'ccusage_no_cache', tool: 'ccusage-codex monthly', cacheMode: 'no cache' },
    { key: 'ccusage_with_cache', tool: 'ccusage-codex monthly --offline', cacheMode: 'with cache' },
    {
      key: 'llm_usage_no_cache',
      tool: buildLlmUsageToolName(config.llmSource, false),
      cacheMode: 'no cache',
    },
    {
      key: 'llm_usage_with_cache',
      tool: buildLlmUsageToolName(config.llmSource, true),
      cacheMode: 'with cache',
    },
  ];

  return definitions.map((definition) => {
    const stats = summaryByScenario[definition.key];

    return {
      Tool: definition.tool,
      Cache: definition.cacheMode,
      'Median (s)': toSeconds(stats.medianMs),
      'Mean (s)': toSeconds(stats.meanMs),
      'Min (s)': toSeconds(stats.minMs),
      'Max (s)': toSeconds(stats.maxMs),
    };
  });
}

function buildMarkdownSummary(report) {
  const runtimeRows = toTableRows(report.summaryByScenario, report.config);
  const speedups = report.derivedSpeedups;
  const specs = report.machine;
  const generatedAt = report.generatedAt;

  const runtimeTableLines = [
    '| Tool | Cache mode | Median (s) | Mean (s) | Min (s) | Max (s) |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...runtimeRows.map(
      (row) =>
        `| \`${row.Tool}\` | ${row.Cache} | ${row['Median (s)']} | ${row['Mean (s)']} | ${row['Min (s)']} | ${row['Max (s)']} |`,
    ),
  ];

  return `## Production benchmark (${generatedAt})

### Baseline machine

| Spec | Value |
| --- | --- |
| OS | ${specs.os} |
| CPU | ${specs.cpuModel} (${specs.logicalCpus} logical CPUs) |
| Memory | ${specs.totalMemoryGiB} GiB RAM |
| Node.js | ${specs.nodeVersion} |
| pnpm | ${specs.pnpmVersion} |
| ccusage-codex | ${specs.ccusageVersion} |
| llm-usage | ${specs.llmUsageVersion} |

### Runtime results (${report.config.runs} runs each)

${runtimeTableLines.join('\n')}

Derived from median runtime:

- \`llm-usage\` vs \`ccusage-codex\` (no cache): \`${speedups.llmVsCcusageNoCache}x\` faster
- \`llm-usage\` vs \`ccusage-codex\` (with cache): \`${speedups.llmVsCcusageWithCache}x\` faster
- \`llm-usage\` cache effect: \`${speedups.llmCacheSpeedup}x\` faster with cache
- \`ccusage-codex\` cache effect: \`${speedups.ccusageCacheSpeedup}x\` faster with cache
`;
}

async function writeOutputFile(filePath, content) {
  const resolvedFilePath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedFilePath), { recursive: true });
  await writeFile(resolvedFilePath, content, 'utf8');
  return resolvedFilePath;
}

function resolveMachineSpecs() {
  const cpu = os.cpus()?.[0];

  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: cpu?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalMemoryGiB: toFixed(os.totalmem() / 1024 ** 3, 1),
    nodeVersion: process.version,
    pnpmVersion: runCommand('pnpm', ['-v']),
    ccusageVersion: runCommand('ccusage-codex', ['--version']),
    llmUsageVersion: runCommand('llm-usage', ['--version']),
  };
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  assertCommandAvailable('ccusage-codex');
  assertCommandAvailable('llm-usage');
  assertCommandAvailable('pnpm');

  const tempCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-prod-benchmark-'));
  const warmCacheRoot = path.join(tempCacheRoot, 'warm');
  const ccusageWarmCacheRoot = path.join(warmCacheRoot, 'ccusage-codex');
  const llmUsageWarmCacheRoot = path.join(warmCacheRoot, 'llm-usage');

  await mkdir(ccusageWarmCacheRoot, { recursive: true });
  await mkdir(llmUsageWarmCacheRoot, { recursive: true });

  const scenarioTimings = {
    ccusage_no_cache: [],
    ccusage_with_cache: [],
    llm_usage_no_cache: [],
    llm_usage_with_cache: [],
  };
  const llmUsageNoCacheArgs = buildLlmUsageArgs(cliArgs.llmSource, false);
  const llmUsageWithCacheArgs = buildLlmUsageArgs(cliArgs.llmSource, true);

  try {
    // Warm cache directories before sampled runs.
    runCommand('ccusage-codex', ['monthly', '--offline', '--json'], {
      env: {
        XDG_CACHE_HOME: ccusageWarmCacheRoot,
      },
    });

    runCommand('llm-usage', llmUsageNoCacheArgs, {
      env: {
        XDG_CACHE_HOME: llmUsageWarmCacheRoot,
        LLM_USAGE_SKIP_UPDATE_CHECK: '1',
      },
    });

    runCommand('llm-usage', llmUsageWithCacheArgs, {
      env: {
        XDG_CACHE_HOME: llmUsageWarmCacheRoot,
        LLM_USAGE_SKIP_UPDATE_CHECK: '1',
      },
    });

    for (let runIndex = 1; runIndex <= cliArgs.runs; runIndex += 1) {
      const runCacheRoot = path.join(tempCacheRoot, `run-${runIndex}`);
      const ccusageNoCacheRoot = path.join(runCacheRoot, 'ccusage-codex');
      const llmUsageNoCacheRoot = path.join(runCacheRoot, 'llm-usage');

      await mkdir(ccusageNoCacheRoot, { recursive: true });
      await mkdir(llmUsageNoCacheRoot, { recursive: true });

      scenarioTimings.ccusage_no_cache.push(
        measureCommand('ccusage-codex', ['monthly', '--no-offline', '--json'], {
          env: {
            XDG_CACHE_HOME: ccusageNoCacheRoot,
          },
        }),
      );

      scenarioTimings.ccusage_with_cache.push(
        measureCommand('ccusage-codex', ['monthly', '--offline', '--json'], {
          env: {
            XDG_CACHE_HOME: ccusageWarmCacheRoot,
          },
        }),
      );

      scenarioTimings.llm_usage_no_cache.push(
        measureCommand('llm-usage', llmUsageNoCacheArgs, {
          env: {
            XDG_CACHE_HOME: llmUsageNoCacheRoot,
            LLM_USAGE_EVENT_STORE: '0',
            LLM_USAGE_SKIP_UPDATE_CHECK: '1',
          },
        }),
      );

      scenarioTimings.llm_usage_with_cache.push(
        measureCommand('llm-usage', llmUsageWithCacheArgs, {
          env: {
            XDG_CACHE_HOME: llmUsageWarmCacheRoot,
            LLM_USAGE_SKIP_UPDATE_CHECK: '1',
          },
        }),
      );
    }
  } finally {
    if (!cliArgs.keepTempCache) {
      await rm(tempCacheRoot, { recursive: true, force: true });
    }
  }

  const summaryByScenario = {
    ccusage_no_cache: summarize(scenarioTimings.ccusage_no_cache),
    ccusage_with_cache: summarize(scenarioTimings.ccusage_with_cache),
    llm_usage_no_cache: summarize(scenarioTimings.llm_usage_no_cache),
    llm_usage_with_cache: summarize(scenarioTimings.llm_usage_with_cache),
  };

  const derivedSpeedups = {
    llmVsCcusageNoCache: toFixed(
      summaryByScenario.ccusage_no_cache.medianMs / summaryByScenario.llm_usage_no_cache.medianMs,
    ),
    llmVsCcusageWithCache: toFixed(
      summaryByScenario.ccusage_with_cache.medianMs /
        summaryByScenario.llm_usage_with_cache.medianMs,
    ),
    llmCacheSpeedup: toFixed(
      summaryByScenario.llm_usage_no_cache.medianMs /
        summaryByScenario.llm_usage_with_cache.medianMs,
    ),
    ccusageCacheSpeedup: toFixed(
      summaryByScenario.ccusage_no_cache.medianMs / summaryByScenario.ccusage_with_cache.medianMs,
    ),
  };

  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    config: {
      runs: cliArgs.runs,
      llmSource: cliArgs.llmSource,
    },
    machine: resolveMachineSpecs(),
    scenarios: scenarioTimings,
    summaryByScenario,
    derivedSpeedups,
  };

  console.log('Production benchmark summary');
  console.table(toTableRows(summaryByScenario, report.config));
  console.log('Derived speedups (median):');
  console.log(
    `- llm-usage vs ccusage-codex (no cache): ${derivedSpeedups.llmVsCcusageNoCache.toFixed(2)}x`,
  );
  console.log(
    `- llm-usage vs ccusage-codex (with cache): ${derivedSpeedups.llmVsCcusageWithCache.toFixed(2)}x`,
  );
  console.log(`- llm-usage cache speedup: ${derivedSpeedups.llmCacheSpeedup.toFixed(2)}x`);
  console.log(`- ccusage-codex cache speedup: ${derivedSpeedups.ccusageCacheSpeedup.toFixed(2)}x`);

  if (cliArgs.jsonOutputPath) {
    const outputPath = await writeOutputFile(
      cliArgs.jsonOutputPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`Wrote JSON benchmark report: ${outputPath}`);
  }

  if (cliArgs.markdownOutputPath) {
    const markdown = buildMarkdownSummary(report);
    const outputPath = await writeOutputFile(cliArgs.markdownOutputPath, `${markdown}\n`);
    console.log(`Wrote markdown benchmark summary: ${outputPath}`);
  }
}

await main();
