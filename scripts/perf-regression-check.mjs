// Compares the CLI runtime of two builds (the PR and its base branch) on one generated
// corpus, and fails when the PR is slower beyond noise. Both builds run alternately in
// the same process tree, so machine-wide slowdowns hit both sides alike.
//
// Run: node scripts/perf-regression-check.mjs --base <dist/index.js> --head <dist/index.js>
//      [--runs 9] [--threshold 0.15] [--min-ms 30] [--markdown-output <path>]

import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const CORPUS = {
  claude: { sessions: 300, turns: 300 },
  codex: { sessions: 200, turns: 300 },
  pi: { sessions: 100, turns: 200 },
};
const SOURCES = Object.keys(CORPUS);
const MINUTE_MS = 60_000;
const TURN_MS = 9 * MINUTE_MS;
// The corpus spans about 15 days and ends a minute ago, so statusline always has usage
// today to summarize.
const LAST_SLOT = Math.max(
  ...Object.values(CORPUS).map(({ sessions, turns }) => (sessions - 1) * 7 + turns - 1),
);
const START_MS = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - MINUTE_MS - LAST_SLOT * TURN_MS;

function printHelp() {
  console.log(`Usage: node scripts/perf-regression-check.mjs --base <entry> --head <entry> [options]

Times the base and head CLI entries (each a built dist/index.js) on a generated
claude/codex/pi corpus, alternating them run by run, and exits 1 when a head
median exceeds the base median by more than both --threshold and --min-ms.

Options:
  --runs <n>                 timed runs per build and cell (default 9)
  --threshold <ratio>        allowed relative slowdown (default 0.15)
  --min-ms <ms>              allowed absolute slowdown (default 30)
  --markdown-output <path>   also write the result table to this file
  --help                     show this help`);
}

function parseArgs(argv) {
  const args = { runs: 9, threshold: 0.15, minMs: 30 };
  const readValue = (index) => {
    const value = argv[index + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argv[index]} needs a value`);
    }

    return value;
  };
  const readNumber = (index, isValid) => {
    const value = Number(readValue(index));

    if (!Number.isFinite(value) || !isValid(value)) {
      throw new Error(`${argv[index]} got an invalid value: ${argv[index + 1]}`);
    }

    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--base':
        args.base = path.resolve(readValue(index));
        index += 1;
        break;
      case '--head':
        args.head = path.resolve(readValue(index));
        index += 1;
        break;
      case '--runs':
        args.runs = readNumber(index, (value) => Number.isInteger(value) && value >= 3);
        index += 1;
        break;
      case '--threshold':
        args.threshold = readNumber(index, (value) => value >= 0);
        index += 1;
        break;
      case '--min-ms':
        args.minMs = readNumber(index, (value) => value >= 0);
        index += 1;
        break;
      case '--markdown-output':
        args.markdownOutput = path.resolve(readValue(index));
        index += 1;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${argv[index]}`);
    }
  }

  if (!args.base || !args.head) {
    throw new Error('--base and --head are required');
  }

  return args;
}

function timestampAt(session, turn) {
  return new Date(START_MS + (session * 7 + turn) * TURN_MS).toISOString();
}

function claudeSession(session, turns) {
  const lines = [];

  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: timestampAt(session, turn),
        sessionId: `claude-${session}`,
        cwd: `/work/project-${session % 12}`,
        uuid: `claude-${session}-row-${turn}`,
        message: {
          id: `claude-${session}-msg-${turn}`,
          role: 'assistant',
          model: turn % 3 === 0 ? 'claude-opus-4-5' : 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'x'.repeat(200 + (turn % 50)) }],
          usage: {
            input_tokens: 40 + (turn % 90),
            cache_creation_input_tokens: turn % 7 === 0 ? 1_200 : 0,
            cache_read_input_tokens: 8_000 + turn * 11,
            output_tokens: 120 + (turn % 300),
          },
        },
      }),
      // Rows without usage, as real transcripts mostly are.
      JSON.stringify({
        type: 'user',
        timestamp: timestampAt(session, turn),
        sessionId: `claude-${session}`,
        message: { role: 'user', content: 'y'.repeat(300 + (turn % 80)) },
      }),
    );
  }

  return `${lines.join('\n')}\n`;
}

function codexSession(session, turns) {
  const lines = [
    JSON.stringify({
      timestamp: timestampAt(session, 0),
      type: 'session_meta',
      payload: { id: `codex-${session}`, model_provider: 'openai' },
    }),
    JSON.stringify({
      timestamp: timestampAt(session, 0),
      type: 'turn_context',
      payload: { model: session % 2 === 0 ? 'gpt-5.2-codex' : 'gpt-5.1' },
    }),
  ];
  const total = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };

  for (let turn = 0; turn < turns; turn += 1) {
    const last = {
      input_tokens: 2_000 + (turn % 500),
      cached_input_tokens: 1_500 + (turn % 400),
      output_tokens: 300 + (turn % 200),
      reasoning_output_tokens: 100 + (turn % 50),
    };

    for (const key of Object.keys(total)) {
      total[key] += last[key];
    }

    lines.push(
      JSON.stringify({
        timestamp: timestampAt(session, turn),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'z'.repeat(250 + (turn % 60)) },
      }),
      JSON.stringify({
        timestamp: timestampAt(session, turn),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              ...total,
              total_tokens: total.input_tokens + total.output_tokens,
            },
            last_token_usage: { ...last, total_tokens: last.input_tokens + last.output_tokens },
          },
        },
      }),
    );
  }

  return `${lines.join('\n')}\n`;
}

function piSession(session, turns) {
  const lines = [
    JSON.stringify({ type: 'session', id: `pi-${session}`, timestamp: timestampAt(session, 0) }),
    JSON.stringify({ type: 'model_change', provider: 'anthropic', modelId: 'claude-sonnet-4-5' }),
  ];

  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(
      JSON.stringify({
        type: 'message',
        timestamp: timestampAt(session, turn),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'w'.repeat(200 + (turn % 40)) }],
          usage: {
            input: 50 + (turn % 70),
            output: 150 + (turn % 120),
            cacheRead: 6_000 + turn * 9,
            cacheWrite: turn % 9 === 0 ? 900 : 0,
          },
        },
      }),
    );
  }

  return `${lines.join('\n')}\n`;
}

async function writeCorpus(rootDir) {
  const writers = { claude: claudeSession, codex: codexSession, pi: piSession };
  const dirs = {};

  for (const source of SOURCES) {
    const { sessions, turns } = CORPUS[source];
    dirs[source] = path.join(rootDir, source);

    for (let session = 0; session < sessions; session += 1) {
      const projectDir = path.join(dirs[source], `project-${session % 12}`);
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(
          projectDir,
          `${timestampAt(session, 0).replaceAll(':', '-')}_${source}-${session}.jsonl`,
        ),
        writers[source](session, turns),
      );
    }
  }

  return dirs;
}

function sourceArgs(dirs) {
  return [
    '--source',
    SOURCES.join(','),
    ...SOURCES.flatMap((source) => ['--source-dir', `${source}=${dirs[source]}`]),
    '--timezone',
    'UTC',
  ];
}

// A build that exits 0 without doing the work would look fast, so the untimed run of
// each cell must show it: every source's usage in the daily report, and a statusline with
// a nonzero figure, which it has only when it summarized today's usage.
function readDailyTokensBySource(stdout) {
  const tokensBySource = {};

  for (const row of JSON.parse(stdout).data ?? []) {
    if (row.rowType === 'period_source') {
      tokensBySource[row.source] = (tokensBySource[row.source] ?? 0) + row.totalTokens;
    }
  }

  const missing = SOURCES.filter((source) => !(tokensBySource[source] > 0));

  if (missing.length > 0) {
    throw new Error(`the daily report has no usage from ${missing.join(', ')}`);
  }

  return tokensBySource;
}

function readStatusline(stdout) {
  if (!/[1-9]/.test(stdout)) {
    throw new Error(`the statusline shows no usage: ${JSON.stringify(stdout)}`);
  }

  return stdout.trim();
}

function cellsFor(dirs) {
  const reportArgs = ['daily', '--all', '--pricing-offline', '--json', ...sourceArgs(dirs)];

  return [
    {
      name: 'daily, cold (no event store)',
      args: reportArgs,
      eventStore: false,
      readWorkload: readDailyTokensBySource,
    },
    {
      name: 'daily, warm event store',
      args: reportArgs,
      eventStore: true,
      readWorkload: readDailyTokensBySource,
    },
    {
      name: 'statusline, warm event store',
      args: ['statusline', ...sourceArgs(dirs)],
      eventStore: true,
      readWorkload: readStatusline,
    },
  ];
}

// Each build gets its own config, cache, and data homes, so neither reads the other's
// event store or pricing cache, and nothing touches the runner's real home.
function buildEnv(stateDir, eventStore) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('LLM_USAGE_')),
  );

  return {
    ...env,
    HOME: path.join(stateDir, 'home'),
    XDG_CONFIG_HOME: path.join(stateDir, 'config'),
    XDG_CACHE_HOME: path.join(stateDir, 'cache'),
    XDG_DATA_HOME: path.join(stateDir, 'data'),
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    LLM_USAGE_EVENT_STORE: eventStore ? '1' : '0',
    TZ: 'UTC',
    NO_COLOR: '1',
  };
}

function runOnce(build, cell) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [build.entry, ...cell.args], {
    env: buildEnv(build.stateDir, cell.eventStore),
    input: '',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = performance.now() - startedAt;

  if (result.status !== 0) {
    throw new Error(
      `${build.name} failed on "${cell.name}" (exit ${result.status}):\n${result.stderr}`,
    );
  }

  return { durationMs, stdout: result.stdout };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function measureCell(builds, cell, runs) {
  const durations = new Map(builds.map((build) => [build.name, []]));

  const workloads = {};

  // One untimed run each warms the event store and the OS page cache, and shows the work.
  for (const build of builds) {
    const { stdout } = runOnce(build, cell);

    try {
      workloads[build.name] = cell.readWorkload(stdout);
    } catch (error) {
      throw new Error(`${build.name} did not do the work on "${cell.name}": ${error.message}`);
    }
  }

  for (let run = 0; run < runs; run += 1) {
    const order = run % 2 === 0 ? builds : [...builds].reverse();

    for (const build of order) {
      durations.get(build.name).push(runOnce(build, cell).durationMs);
    }
  }

  return {
    base: median(durations.get('base')),
    head: median(durations.get('head')),
    sameWorkload: JSON.stringify(workloads.base) === JSON.stringify(workloads.head),
  };
}

function formatTable(results, args) {
  const lines = [
    '| Cell | Base (ms) | PR (ms) | Change | Verdict |',
    '| --- | ---: | ---: | ---: | --- |',
  ];

  for (const result of results) {
    const change = (result.head - result.base) / result.base;
    lines.push(
      `| ${result.name} | ${result.base.toFixed(0)} | ${result.head.toFixed(0)} | ${(change * 100).toFixed(1)}% | ${result.regressed ? 'slower' : 'ok'} |`,
    );
  }

  const differing = results.filter((result) => !result.sameWorkload).map((result) => result.name);

  if (differing.length > 0) {
    lines.push(
      '',
      `The PR reports different figures than its base on: ${differing.join('; ')}. Expected for a change to parsing or reporting; otherwise the timings compare unlike work.`,
    );
  }

  const corpus = SOURCES.map(
    (source) => `${source} ${CORPUS[source].sessions}×${CORPUS[source].turns}`,
  ).join(', ');
  lines.push(
    '',
    `Medians of ${args.runs} alternating runs per build. A cell fails when the PR is slower by more than ${(args.threshold * 100).toFixed(0)}% and ${args.minMs} ms. Corpus (sessions×turns): ${corpus}.`,
  );

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-perf-regression-'));

  try {
    const dirs = await writeCorpus(path.join(rootDir, 'corpus'));
    const builds = [
      { name: 'base', entry: args.base, stateDir: path.join(rootDir, 'base') },
      { name: 'head', entry: args.head, stateDir: path.join(rootDir, 'head') },
    ];
    const results = [];

    for (const cell of cellsFor(dirs)) {
      const { base, head, sameWorkload } = measureCell(builds, cell, args.runs);
      const regressed = head - base > args.minMs && head > base * (1 + args.threshold);
      results.push({ name: cell.name, base, head, regressed, sameWorkload });
    }

    const table = formatTable(results, args);
    console.log(table);

    if (args.markdownOutput) {
      await writeFile(args.markdownOutput, `${table}\n`);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Speed check\n\n${table}\n`);
    }

    if (results.some((result) => result.regressed)) {
      console.error('The PR is slower than its base beyond the allowed noise.');
      process.exitCode = 1;
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

await main();
