// Runs the built CLI (the published dist/bin.js loader) under Bun and checks it against Node on the e2e fixtures:
// identical report JSON on a cold run whose Codex files really parse in worker
// threads, and on a warm run served from the SQLite event store, plus a one-line
// statusline. A node:sqlite preflight makes a missing SQLite fatal instead of the
// OpenCode smoke check skipping.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fixturesDir = path.resolve('tests/fixtures/e2e');
const reportArgs = [
  'dist/bin.js',
  'daily',
  '--all',
  '--source',
  'pi,codex,claude',
  '--pi-dir',
  path.join(fixturesDir, 'pi'),
  '--codex-dir',
  path.join(fixturesDir, 'codex'),
  '--claude-dir',
  path.join(fixturesDir, 'claude'),
  '--timezone',
  'UTC',
  '--pricing-offline',
  '--json',
];

function createEnv(root) {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key.startsWith('LLM_USAGE_')) {
      delete env[key];
    }
  }

  return {
    ...env,
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    LLM_USAGE_PARSE_WORKERS: '2',
    LLM_USAGE_PARSE_WORKER_MIN_BYTES: '0',
    LLM_USAGE_PROFILE_RUNTIME: '1',
  };
}

/** Runs the CLI and returns stdout and stderr, failing loudly on a non-zero exit. */
function run(runtime, args, env) {
  const result = spawnSync(runtime, args, { env, encoding: 'utf8', timeout: 60_000 });

  if (result.error) {
    throw new Error(`Could not run ${runtime}: ${result.error.message}`, { cause: result.error });
  }

  if (result.status !== 0) {
    throw new Error(`${runtime} ${args.join(' ')} exited ${result.status}:\n${result.stderr}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

function runReport(runtime, env) {
  const { stdout, stderr } = run(runtime, reportArgs, env);
  return { data: JSON.parse(stdout).data, stderr };
}

function assertSame(label, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${label}: Bun report differs from Node`);
  }
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-bun-smoke-'));

  try {
    // The event store and the OpenCode source need node:sqlite; a skip would hide its loss.
    run(
      'bun',
      [
        '-e',
        "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:').exec('select 1');",
      ],
      process.env,
    );

    const nodeData = runReport('node', createEnv(path.join(root, 'node'))).data;
    const bunEnv = createEnv(path.join(root, 'bun'));
    const cold = runReport('bun', bunEnv);
    const coldData = cold.data;
    const warm = runReport('bun', bunEnv);

    // Equal output alone would also come from the inline fallback when workers fail.
    if (
      !/source codex:[^\n]*parseWorkers=engaged/u.test(cold.stderr) ||
      /fallback/u.test(cold.stderr)
    ) {
      throw new Error(`The cold Bun run did not parse in worker threads:\n${cold.stderr}`);
    }

    if (nodeData.length === 0) {
      throw new Error('The fixture report is empty; the smoke check would prove nothing');
    }

    assertSame('cold run', coldData, nodeData);
    assertSame('warm run', warm.data, nodeData);

    if (!/event store: hits=[1-9]\d*; misses=0/u.test(warm.stderr)) {
      throw new Error(`The warm Bun run did not read from the event store:\n${warm.stderr}`);
    }

    const statusline = run(
      'bun',
      ['dist/bin.js', 'statusline', '--source', 'pi', '--pi-dir', path.join(fixturesDir, 'pi')],
      bunEnv,
    ).stdout.trimEnd();

    if (statusline.split('\n').length !== 1 || !statusline.includes(' this month')) {
      throw new Error(`Unexpected Bun statusline output: ${JSON.stringify(statusline)}`);
    }

    console.log(
      `Bun smoke check passed: ${nodeData.length} report rows match Node (cold and warm); statusline: ${statusline}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
