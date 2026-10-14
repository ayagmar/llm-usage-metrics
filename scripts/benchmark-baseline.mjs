import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const llmEntryPath = path.join(repoRoot, 'dist', 'bin.js');

const BENCHMARK_TIMEZONE = 'UTC';
const GNU_TIME_PATH = '/usr/bin/time';
const ACTIVE_APPEND_LINES = 1_000;
const LINE_INTERVAL_MS = 60_000;
const APPEND_INTERVAL_MS = 1_000;
const WRITE_CHUNK_LINES = 10_000;
const FILES_PER_SOURCE = 4;
// Each file starts with two header lines and needs at least one usage line.
const MIN_LINES = FILES_PER_SOURCE * 3;

const SCENARIO_LABELS = {
  cold: 'cold (store off, OS page cache warm)',
  warm: 'warm (store on)',
  statusline: 'statusline (store on)',
  'active-jsonl': 'active-jsonl (store on, pi file grows)',
};

const METHODOLOGY_LINES = [
  'Methodology:',
  '  - Runs the built CLI entry (node dist/bin.js, with the V8 compile cache) directly;',
  '    timing excludes pnpm/npx launcher overhead. Build first: pnpm run build.',
  '    NODE_COMPILE_CACHE points at a temp dir that one untimed priming run fills.',
  `  - Corpus: synthetic pi and codex sessions, ${FILES_PER_SOURCE} files per source, generated`,
  '    in a temp dir with the line shapes of tests/fixtures/e2e-large. One usage line per',
  '    minute, ending minutes before the run starts, so today and this month hold data.',
  '  - Environment: temp HOME, XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, a',
  '    missing LLM_USAGE_CONFIG_PATH, LLM_USAGE_SKIP_UPDATE_CHECK=1, TZ=UTC; every',
  '    inherited LLM_USAGE_* variable is removed. Every command passes',
  '    --source pi,codex --pi-dir <dir> --codex-dir <dir>; stdin is ignored.',
  '  - cold (store off, OS page cache warm): LLM_USAGE_EVENT_STORE=0, fresh cache dir',
  '    per run, daily --all --json --pricing-offline. The corpus was just written, so',
  '    its files are in the OS page cache; this is not a cold-disk number.',
  '  - warm: event store on, one priming run, then timed repeats of the cold command.',
  '  - statusline: event store on, one priming run, then timed repeats of statusline',
  '    (no --pricing-offline: the statusline never fetches).',
  '  - active-jsonl: event store on, one priming run on a copy of the corpus; each run',
  `    appends ${ACTIVE_APPEND_LINES} new rows with later timestamps to the newest pi file, then`,
  '    times the cold command. An untimed session --json run after each timed run',
  '    checks that the event count grew by the appended rows.',
  '  - Max RSS comes from /usr/bin/time -f %M only if the probe /usr/bin/time -f %M true',
  '    succeeds, else n/a. The OS page cache is not flushed.',
];

function printHelp() {
  console.log(`Usage: node scripts/benchmark-baseline.mjs [options]

Time the built CLI over a synthetic pi + codex corpus: cold run, warm run,
statusline tick, and a large active JSONL file that grows between runs.

${METHODOLOGY_LINES.join('\n')}

Options:
  --runs <count>      Number of timed runs per scenario (default: 5)
  --lines <count>     Lines per source, spread over ${FILES_PER_SOURCE} files (default: 200000)
  --out <dir>         Directory for <date>-baseline.json and <date>-baseline.md
                      (default: docs/benchmarks)
  --keep-temp         Keep the temp corpus and state directory for inspection
  -h, --help          Show this help
`);
}

function parsePositiveInteger(flag, value) {
  if (!value) {
    throw new Error(`${flag} requires a numeric value`);
  }

  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }

  return parsedValue;
}

function parseCliArgs(argv) {
  const args = {
    runs: 5,
    lines: 200_000,
    outDir: path.join(repoRoot, 'docs', 'benchmarks'),
    keepTemp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--') {
      continue;
    }

    switch (arg) {
      case '--runs':
        args.runs = parsePositiveInteger('--runs', argv[index + 1]);
        index += 1;
        break;
      case '--lines': {
        const lines = parsePositiveInteger('--lines', argv[index + 1]);

        if (lines < MIN_LINES) {
          throw new Error(`--lines must be at least ${MIN_LINES}`);
        }

        args.lines = lines;
        index += 1;
        break;
      }
      case '--out': {
        const value = argv[index + 1];

        if (!value) {
          throw new Error('--out requires a directory path');
        }

        args.outDir = path.resolve(value);
        index += 1;
        break;
      }
      case '--keep-temp':
        args.keepTemp = true;
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
    maxBuffer: 256 * 1024 * 1024,
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

function probeGnuTime() {
  const result = spawnSync(GNU_TIME_PATH, ['-f', '%M', 'true'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// Times one CLI run. With GNU time, the run is wrapped so its max RSS (KiB) lands in rssFile.
async function measureCli(cliArgs, env, context) {
  const command = context.gnuTime ? GNU_TIME_PATH : process.execPath;
  const commandArgs = context.gnuTime
    ? ['-f', '%M', '-o', context.rssFile, process.execPath, llmEntryPath, ...cliArgs]
    : [llmEntryPath, ...cliArgs];

  const startedAt = process.hrtime.bigint();
  const stdout = runCommand(command, commandArgs, { env, cwd: context.tempRoot });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  if (!context.gnuTime) {
    return { elapsedMs, maxRssMb: undefined, stdout };
  }

  const rssKib = Number.parseInt((await readFile(context.rssFile, 'utf8')).trim(), 10);
  return { elapsedMs, maxRssMb: rssKib / 1024, stdout };
}

// The child sees no inherited LLM_USAGE_* variable and no HOME outside the temp dir.
function buildBaselineEnv(context, stateRoot, eventStorePath) {
  const env = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('LLM_USAGE_') && value !== undefined) {
      env[name] = value;
    }
  }

  const eventStoreEnv = eventStorePath
    ? { LLM_USAGE_EVENT_STORE: '1', LLM_USAGE_EVENT_STORE_PATH: eventStorePath }
    : { LLM_USAGE_EVENT_STORE: '0' };

  return {
    ...env,
    TZ: BENCHMARK_TIMEZONE,
    HOME: path.join(stateRoot, 'home'),
    NODE_COMPILE_CACHE: context.compileCacheDir,
    XDG_CACHE_HOME: path.join(stateRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(stateRoot, 'config'),
    XDG_DATA_HOME: path.join(stateRoot, 'data'),
    LLM_USAGE_CONFIG_PATH: path.join(stateRoot, 'config', 'missing-config.toml'),
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    ...eventStoreEnv,
  };
}

async function createStateRoot(parentDir, name) {
  const stateRoot = path.join(parentDir, name);

  for (const dir of ['home', 'cache', 'config', 'data']) {
    await mkdir(path.join(stateRoot, dir), { recursive: true });
  }

  return stateRoot;
}

function sourceArgs(corpus) {
  return ['--source', 'pi,codex', '--pi-dir', corpus.piDir, '--codex-dir', corpus.codexDir];
}

function dailyArgs(corpus) {
  return [
    'daily',
    '--all',
    '--json',
    '--pricing-offline',
    '--timezone',
    BENCHMARK_TIMEZONE,
    ...sourceArgs(corpus),
  ];
}

function statuslineArgs(corpus) {
  return ['statusline', '--timezone', BENCHMARK_TIMEZONE, ...sourceArgs(corpus)];
}

function toTimestamp(clock, lineIndex) {
  return new Date(clock.startMs + lineIndex * LINE_INTERVAL_MS).toISOString();
}

// Same shape as tests/fixtures/e2e-large/pi/session-large.jsonl, with varied token counts.
function piMessageLine(timestamp, lineIndex) {
  const input = 200 + (lineIndex % 97);
  const output = 50 + (lineIndex % 31);
  return JSON.stringify({
    type: 'message',
    timestamp,
    provider: 'openai',
    usage: { input, output, totalTokens: input + output, cost: { total: 0.001 } },
  });
}

function codexTokenCountLine(clock, lineIndex, totals) {
  const last = {
    input_tokens: 400 + (lineIndex % 89),
    cached_input_tokens: 100,
    output_tokens: 200 + (lineIndex % 23),
    reasoning_output_tokens: 50,
  };
  last.total_tokens = last.input_tokens + last.output_tokens;

  for (const key of Object.keys(last)) {
    totals[key] += last[key];
  }

  return JSON.stringify({
    timestamp: toTimestamp(clock, lineIndex),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { ...totals }, last_token_usage: last },
    },
  });
}

async function writeLines(filePath, header, lineCount, buildLine) {
  await writeFile(filePath, header.map((line) => `${line}\n`).join(''), 'utf8');

  for (let start = 0; start < lineCount; start += WRITE_CHUNK_LINES) {
    const end = Math.min(start + WRITE_CHUNK_LINES, lineCount);
    const chunk = [];

    for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
      chunk.push(`${buildLine(lineIndex)}\n`);
    }

    await appendFile(filePath, chunk.join(''), 'utf8');
  }
}

// Splits `lines` per source over FILES_PER_SOURCE files: two header lines each, then usage
// lines one minute apart. Line indexes run across files, so each file covers its own span.
function planCorpusFiles(lines) {
  const usageLines = lines - FILES_PER_SOURCE * 2;
  const baseCount = Math.floor(usageLines / FILES_PER_SOURCE);
  const files = [];
  let firstLineIndex = 0;

  for (let fileIndex = 0; fileIndex < FILES_PER_SOURCE; fileIndex += 1) {
    const lineCount = fileIndex === FILES_PER_SOURCE - 1 ? usageLines - firstLineIndex : baseCount;
    files.push({ name: `session-${fileIndex + 1}.jsonl`, fileIndex, firstLineIndex, lineCount });
    firstLineIndex += lineCount;
  }

  return { files, usageLines };
}

async function generateCorpus(corpusRoot, cliArgs, clock) {
  const piDir = path.join(corpusRoot, 'pi');
  const codexDir = path.join(corpusRoot, 'codex');
  const { files, usageLines } = planCorpusFiles(cliArgs.lines);

  await mkdir(piDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });

  for (const file of files) {
    const startTimestamp = toTimestamp(clock, file.firstLineIndex);
    const buildLineIndex = (offset) => file.firstLineIndex + offset;

    await writeLines(
      path.join(piDir, file.name),
      [
        JSON.stringify({
          type: 'session',
          id: `pi-baseline-session-${file.fileIndex + 1}`,
          timestamp: startTimestamp,
        }),
        JSON.stringify({ type: 'model_change', provider: 'openai', modelId: 'gpt-4.1' }),
      ],
      file.lineCount,
      (offset) => piMessageLine(toTimestamp(clock, buildLineIndex(offset)), buildLineIndex(offset)),
    );

    const codexTotals = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    };
    await writeLines(
      path.join(codexDir, file.name),
      [
        JSON.stringify({
          timestamp: startTimestamp,
          type: 'session_meta',
          payload: { id: `codex-baseline-session-${file.fileIndex + 1}`, model_provider: 'openai' },
        }),
        JSON.stringify({
          timestamp: startTimestamp,
          type: 'turn_context',
          payload: { model: 'gpt-5.2-codex' },
        }),
      ],
      file.lineCount,
      (offset) => codexTokenCountLine(clock, buildLineIndex(offset), codexTotals),
    );
  }

  return {
    piDir,
    codexDir,
    // The newest pi session is the one still being written.
    piFile: path.join(piDir, files[files.length - 1].name),
    firstAppendLineIndex: usageLines,
    nextPiLineIndex: usageLines,
  };
}

async function appendPiLines(corpus, clock) {
  const lines = [];

  for (let offset = 0; offset < ACTIVE_APPEND_LINES; offset += 1) {
    const lineIndex = corpus.nextPiLineIndex + offset;
    const appendIndex = lineIndex - corpus.firstAppendLineIndex;
    const timestamp = new Date(clock.appendStartMs + appendIndex * APPEND_INTERVAL_MS);
    lines.push(`${piMessageLine(timestamp.toISOString(), lineIndex)}\n`);
  }

  await appendFile(corpus.piFile, lines.join(''), 'utf8');
  corpus.nextPiLineIndex += ACTIVE_APPEND_LINES;
}

// Fails the benchmark when the report is empty, so a parser that silently skips the
// synthetic lines cannot produce a fast but meaningless number.
function readDailyTotals(stdout) {
  const report = JSON.parse(stdout);
  const periodSourceRows = report.data.filter((row) => row.rowType === 'period_source');
  const periods = new Set(periodSourceRows.map((row) => row.periodKey)).size;
  const sources = [...new Set(periodSourceRows.map((row) => row.source))].sort();
  const totalTokens = report.data.find((row) => row.rowType === 'grand_total')?.totalTokens ?? 0;

  if (totalTokens <= 0 || sources.join(',') !== 'codex,pi') {
    throw new Error(
      `Benchmark corpus produced no usage for pi and codex (sources: ${sources.join(',') || 'none'}, tokens: ${totalTokens})`,
    );
  }

  return { periods, totalTokens };
}

function sessionArgs(corpus) {
  return [
    'session',
    '--top',
    '0',
    '--json',
    '--pricing-offline',
    '--timezone',
    BENCHMARK_TIMEZONE,
    ...sourceArgs(corpus),
  ];
}

function readEventCount(stdout) {
  const report = JSON.parse(stdout);
  return report.data.reduce((sum, row) => sum + row.eventCount, 0);
}

function summarize(samples) {
  const sorted = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const rssValues = samples.map((sample) => sample.maxRssMb).filter((value) => value !== undefined);

  return {
    runs: sorted.length,
    medianMs: toFixed(medianMs),
    minMs: toFixed(sorted[0]),
    maxMs: toFixed(sorted[sorted.length - 1]),
    maxRssMb: rssValues.length > 0 ? toFixed(Math.max(...rssValues), 1) : null,
  };
}

function toFixed(value, digits = 2) {
  return Number(value.toFixed(digits));
}

// Fills NODE_COMPILE_CACHE, so every timed run starts from compiled CLI code.
// Also returns the corpus totals the report prints.
async function primeCompileCache(corpus, context) {
  const stateRoot = await createStateRoot(context.tempRoot, 'compile-cache-priming');
  const env = buildBaselineEnv(context, stateRoot);
  const totals = readDailyTotals((await measureCli(dailyArgs(corpus), env, context)).stdout);
  const events = readEventCount((await measureCli(sessionArgs(corpus), env, context)).stdout);
  return { ...totals, events };
}

async function runColdScenario(corpus, cliArgs, context) {
  const samples = [];

  for (let runIndex = 1; runIndex <= cliArgs.runs; runIndex += 1) {
    const stateRoot = await createStateRoot(context.tempRoot, `cold-${runIndex}`);
    const sample = await measureCli(
      dailyArgs(corpus),
      buildBaselineEnv(context, stateRoot),
      context,
    );
    readDailyTotals(sample.stdout);
    samples.push(sample);
  }

  return { corpus, command: dailyArgs(corpus), samples };
}

async function runRepeatScenario(corpus, cliArgs, context, name, commandArgs) {
  const stateRoot = await createStateRoot(context.tempRoot, name);
  const env = buildBaselineEnv(context, stateRoot, path.join(stateRoot, 'events.sqlite'));

  await measureCli(commandArgs, env, context);

  const samples = [];

  for (let runIndex = 1; runIndex <= cliArgs.runs; runIndex += 1) {
    samples.push(await measureCli(commandArgs, env, context));
  }

  return { corpus, command: commandArgs, samples };
}

async function runActiveJsonlScenario(sourceCorpus, cliArgs, context, clock) {
  const corpusRoot = path.join(context.tempRoot, 'active-corpus');
  await cp(path.dirname(sourceCorpus.piDir), corpusRoot, { recursive: true });
  const corpus = {
    ...sourceCorpus,
    piDir: path.join(corpusRoot, 'pi'),
    codexDir: path.join(corpusRoot, 'codex'),
    piFile: path.join(corpusRoot, 'pi', path.basename(sourceCorpus.piFile)),
  };
  const stateRoot = await createStateRoot(context.tempRoot, 'active-jsonl');
  const env = buildBaselineEnv(context, stateRoot, path.join(stateRoot, 'events.sqlite'));
  const countEvents = async () =>
    readEventCount((await measureCli(sessionArgs(corpus), env, context)).stdout);

  await measureCli(dailyArgs(corpus), env, context);
  let previousEventCount = await countEvents();
  const samples = [];

  for (let runIndex = 1; runIndex <= cliArgs.runs; runIndex += 1) {
    await appendPiLines(corpus, clock);
    const sample = await measureCli(dailyArgs(corpus), env, context);
    readDailyTotals(sample.stdout);
    samples.push(sample);

    // The appended rows must all count, or the timed run may have hit a stale cache.
    const eventCount = await countEvents();

    if (eventCount !== previousEventCount + ACTIVE_APPEND_LINES) {
      throw new Error(
        `active-jsonl run ${runIndex}: expected ${previousEventCount + ACTIVE_APPEND_LINES} events after appending ${ACTIVE_APPEND_LINES} rows, got ${eventCount}`,
      );
    }

    previousEventCount = eventCount;
  }

  return { corpus, command: dailyArgs(corpus), samples };
}

// Shows commands with the temp corpus paths replaced, so reports from different runs compare.
function displayCommand(commandArgs, corpus) {
  return [
    'llm-usage',
    ...commandArgs.map((arg) => {
      if (arg === corpus.piDir) {
        return '<pi-dir>';
      }

      if (arg === corpus.codexDir) {
        return '<codex-dir>';
      }

      return arg;
    }),
  ].join(' ');
}

function formatRss(value) {
  return value === null ? 'n/a' : String(value);
}

function buildMarkdownSummary(report) {
  const specs = report.machine;
  const lines = [
    `## Baseline benchmark (${report.generatedAt})`,
    '',
    '### Machine',
    '',
    '| Spec | Value |',
    '| --- | --- |',
    `| OS | ${specs.os} |`,
    `| CPU | ${specs.cpuModel} (${specs.logicalCpus} logical CPUs) |`,
    `| Memory | ${specs.totalMemoryGiB} GiB RAM |`,
    `| Node.js | ${specs.nodeVersion} |`,
    `| llm-usage | ${specs.llmUsageVersion} (git ${specs.llmUsageGitHead}) |`,
    '',
    '### Corpus',
    '',
    `- ${report.config.lines} lines per source (pi and codex) over ${report.config.filesPerSource} files each: ${report.corpus.events} events, ${report.corpus.periods} daily periods, ${report.corpus.totalTokens} total tokens.`,
    `- ${report.config.runs} timed runs per scenario.`,
    '',
    '### Results',
    '',
    '| Scenario | Command | Median (s) | Min (s) | Max (s) | Max RSS (MB) |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...report.scenarios.map(
      (scenario) =>
        `| ${scenario.label} | \`${scenario.command}\` | ${toSeconds(scenario.summary.medianMs)} | ${toSeconds(scenario.summary.minMs)} | ${toSeconds(scenario.summary.maxMs)} | ${formatRss(scenario.summary.maxRssMb)} |`,
    ),
    '',
    '```text',
    ...METHODOLOGY_LINES,
    '```',
  ];

  return `${lines.join('\n')}\n`;
}

function toSeconds(valueMs) {
  return Number((valueMs / 1_000).toFixed(3));
}

async function resolveMachineSpecs(context) {
  const cpu = os.cpus()?.[0];
  const stateRoot = await createStateRoot(context.tempRoot, 'version');

  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpuModel: cpu?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalMemoryGiB: toFixed(os.totalmem() / 1024 ** 3, 1),
    nodeVersion: process.version,
    llmUsageVersion: runCommand(process.execPath, [llmEntryPath, '--version'], {
      env: buildBaselineEnv(context, stateRoot),
      cwd: context.tempRoot,
    }),
    llmUsageGitHead: runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }),
  };
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  if (!existsSync(llmEntryPath)) {
    throw new Error(`Built CLI not found at ${llmEntryPath}. Run 'pnpm run build' first.`);
  }

  console.log(METHODOLOGY_LINES.join('\n'));

  const generatedAt = new Date();
  // The corpus ends a little before now, leaving room for the lines active-jsonl appends one
  // second apart, so no line is in the future and today holds data for the statusline.
  const appendStartMs =
    generatedAt.getTime() - (cliArgs.runs * ACTIVE_APPEND_LINES + 1) * APPEND_INTERVAL_MS;
  const clock = {
    startMs: appendStartMs - planCorpusFiles(cliArgs.lines).usageLines * LINE_INTERVAL_MS,
    appendStartMs,
  };
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-baseline-benchmark-'));
  const gnuTime = probeGnuTime();
  const context = {
    tempRoot,
    gnuTime,
    rssFile: path.join(tempRoot, 'rss'),
    compileCacheDir: path.join(tempRoot, 'node-compile-cache'),
  };
  let results;
  let corpusTotals;
  let machine;

  try {
    const corpus = await generateCorpus(path.join(tempRoot, 'corpus'), cliArgs, clock);
    console.log(
      `Generated corpus: ${cliArgs.lines} lines per source over ${FILES_PER_SOURCE} files in ${tempRoot}`,
    );

    machine = await resolveMachineSpecs(context);
    corpusTotals = await primeCompileCache(corpus, context);

    const cold = await runColdScenario(corpus, cliArgs, context);
    console.log('Finished cold');
    const warm = await runRepeatScenario(corpus, cliArgs, context, 'warm', dailyArgs(corpus));
    console.log('Finished warm');
    const statusline = await runRepeatScenario(
      corpus,
      cliArgs,
      context,
      'statusline',
      statuslineArgs(corpus),
    );
    console.log('Finished statusline');
    const active = await runActiveJsonlScenario(corpus, cliArgs, context, clock);
    console.log('Finished active-jsonl');

    results = { cold, warm, statusline, 'active-jsonl': active };
  } finally {
    if (cliArgs.keepTemp) {
      console.log(`Kept temp directory: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  const date = generatedAt.toISOString().slice(0, 10);
  const report = {
    generatedAt: date,
    config: {
      runs: cliArgs.runs,
      lines: cliArgs.lines,
      filesPerSource: FILES_PER_SOURCE,
      activeAppendLines: ACTIVE_APPEND_LINES,
      timezone: BENCHMARK_TIMEZONE,
      maxRssSource: gnuTime ? `${GNU_TIME_PATH} -f %M` : 'n/a',
    },
    machine,
    corpus: corpusTotals,
    scenarios: Object.entries(results).map(([name, result]) => ({
      name,
      label: SCENARIO_LABELS[name],
      command: displayCommand(result.command, result.corpus),
      timingsMs: result.samples.map((sample) => toFixed(sample.elapsedMs)),
      summary: summarize(result.samples),
    })),
  };

  console.table(
    report.scenarios.map((scenario) => ({
      Scenario: scenario.label,
      'Median (s)': toSeconds(scenario.summary.medianMs),
      'Min (s)': toSeconds(scenario.summary.minMs),
      'Max (s)': toSeconds(scenario.summary.maxMs),
      'Max RSS (MB)': formatRss(scenario.summary.maxRssMb),
    })),
  );

  await mkdir(cliArgs.outDir, { recursive: true });
  const jsonPath = path.join(cliArgs.outDir, `${date}-baseline.json`);
  const markdownPath = path.join(cliArgs.outDir, `${date}-baseline.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, buildMarkdownSummary(report), 'utf8');
  console.log(`Wrote JSON benchmark report: ${jsonPath}`);
  console.log(`Wrote markdown benchmark summary: ${markdownPath}`);
}

await main();
