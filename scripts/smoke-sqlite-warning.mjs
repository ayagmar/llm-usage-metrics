// Runs the built CLI over an OpenCode fixture and fails if its stderr carries Node's
// SQLite ExperimentalWarning (Node 22 prints it; the CLI's warning filter must drop it),
// with the event store off and on and parse workers enabled.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// The fixture setup loads node:sqlite in this process too; keep its own warning out of
// the output so only the CLI's stderr is judged.
function requireSqliteQuietly() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    const message = warning instanceof Error ? warning.message : String(warning);

    if (message.includes('SQLite is an experimental feature')) {
      return;
    }

    return Reflect.apply(emitWarning, this, [warning, ...args]);
  };

  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

function readGrandTotalTokens(stdout) {
  try {
    return JSON.parse(stdout).data?.find((row) => row.rowType === 'grand_total')?.totalTokens;
  } catch {
    return undefined;
  }
}

function createOpenCodeFixture(dbPath) {
  const { DatabaseSync } = requireSqliteQuietly();
  const database = new DatabaseSync(dbPath);

  try {
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    database
      .prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run(
        'm-1',
        'session-smoke',
        1_737_000_000_000,
        JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1',
          tokens: { input: 10, output: 5, total: 15 },
        }),
      );
  } finally {
    database.close();
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-sqlite-warning-'));
  const dbPath = path.join(tempDir, 'opencode.db');
  const failures = [];

  try {
    createOpenCodeFixture(dbPath);

    for (const eventStore of ['0', '1']) {
      const result = spawnSync(
        process.execPath,
        [
          'dist/index.js',
          'daily',
          '--all',
          '--source',
          'opencode',
          '--opencode-db',
          dbPath,
          '--pricing-offline',
          '--json',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            LLM_USAGE_EVENT_STORE: eventStore,
            LLM_USAGE_PARSE_WORKERS: '2',
            LLM_USAGE_EVENT_STORE_PATH: path.join(tempDir, 'events.db'),
            LLM_USAGE_SKIP_UPDATE_CHECK: '1',
            XDG_CACHE_HOME: path.join(tempDir, 'cache'),
          },
        },
      );
      const label = `LLM_USAGE_EVENT_STORE=${eventStore} on Node ${process.version}`;
      const totalTokens = readGrandTotalTokens(result.stdout);

      if (result.status !== 0) {
        failures.push(`${label}: exit ${String(result.status)}\n${result.stderr}`);
      } else if (totalTokens !== 15) {
        // The fixture row holds 15 tokens; anything else means SQLite was never read.
        failures.push(`${label}: expected 15 total tokens, got ${String(totalTokens)}`);
      } else if (result.stderr.includes('ExperimentalWarning')) {
        failures.push(`${label}: stderr carries ExperimentalWarning\n${result.stderr}`);
      } else {
        console.log(`${label}: no ExperimentalWarning on stderr`);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    throw new Error(`SQLite warning smoke check failed:\n${failures.join('\n')}`);
  }
}

await main();
