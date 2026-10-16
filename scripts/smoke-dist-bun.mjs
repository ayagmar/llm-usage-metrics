// Runs the built CLI (the published dist/bin.js loader) under Bun and checks it against Node on the e2e fixtures:
// identical report JSON on a cold run whose Codex files really parse in worker
// threads, and on a warm run served from the SQLite event store, plus a one-line
// statusline, and a `daily --share` page written under the same file names as Node's.
// A node:sqlite preflight makes a missing SQLite fatal instead of the OpenCode smoke check
// skipping.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fixturesDir = path.resolve('tests/fixtures/e2e');
const binPath = path.resolve('dist/bin.js');
const dailyArgs = [
  binPath,
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
];
const reportArgs = [...dailyArgs, '--json'];
const shareArgs = [...dailyArgs, '--no-sync', '--share', '--no-open'];
// Card M10-D turns this on once every share page embeds its payload.
const compareSharePayload = false;

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
    HOME: path.join(root, 'home'),
    LLM_USAGE_CONFIG_PATH: path.join(root, 'missing-config.toml'),
    LLM_USAGE_SKIP_UPDATE_CHECK: '1',
    LLM_USAGE_PARSE_WORKERS: '2',
    LLM_USAGE_PARSE_WORKER_MIN_BYTES: '0',
    LLM_USAGE_PROFILE_RUNTIME: '1',
  };
}

/** Runs the CLI and returns stdout and stderr, failing loudly on a non-zero exit. */
function run(runtime, args, env, cwd) {
  const result = spawnSync(runtime, args, { env, cwd, encoding: 'utf8', timeout: 60_000 });

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

/** Writes the daily share page in a fresh directory and returns its files by name. */
async function runShare(runtime, env, dir) {
  await mkdir(dir, { recursive: true });
  run(runtime, shareArgs, env, dir);
  const names = (await readdir(dir)).sort();

  if (!names.some((name) => name.endsWith('.html'))) {
    throw new Error(`${runtime} --share wrote no .html file: ${names.join(', ')}`);
  }

  return new Map(
    await Promise.all(
      names.map(async (name) => [name, await readFile(path.join(dir, name), 'utf8')]),
    ),
  );
}

/** The embedded share payload without its generation time, which differs between runs. */
function readSharePayload(html) {
  const openTag = '<script type="application/json" id="report-data">';
  const start = html.indexOf(openTag);
  const end = start === -1 ? -1 : html.indexOf('</script>', start);

  if (end === -1) {
    throw new Error('The share page embeds no report-data payload');
  }

  return JSON.parse(html.slice(start + openTag.length, end), (key, value) =>
    key === 'generatedAt' ? undefined : value,
  );
}

function assertSameShare(nodeFiles, bunFiles) {
  assertSame('share files', [...bunFiles.keys()], [...nodeFiles.keys()]);

  if (!compareSharePayload) {
    return;
  }

  for (const [name, html] of nodeFiles) {
    if (name.endsWith('.html')) {
      assertSame(
        `share payload in ${name}`,
        readSharePayload(bunFiles.get(name)),
        readSharePayload(html),
      );
    }
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

    const nodeEnv = createEnv(path.join(root, 'node'));
    const nodeData = runReport('node', nodeEnv).data;
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

    const shareFiles = await runShare('bun', bunEnv, path.join(root, 'bun-share'));
    assertSameShare(await runShare('node', nodeEnv, path.join(root, 'node-share')), shareFiles);

    console.log(
      `Bun smoke check passed: ${nodeData.length} report rows match Node (cold and warm); share files: ${[...shareFiles.keys()].join(', ')}; statusline: ${statusline}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
