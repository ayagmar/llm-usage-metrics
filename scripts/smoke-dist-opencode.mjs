import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadDatabaseSync() {
  let sqliteModule;

  try {
    sqliteModule = require('node:sqlite');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `Skipping OpenCode dist smoke check: node:sqlite is unavailable in this runtime (${reason}).`,
    );
    return undefined;
  }

  const moduleRecord = sqliteModule;

  if (typeof moduleRecord?.DatabaseSync !== 'function') {
    console.warn(
      'Skipping OpenCode dist smoke check: node:sqlite did not expose DatabaseSync in this runtime.',
    );
    return undefined;
  }

  return moduleRecord.DatabaseSync;
}

function formatExecError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (typeof error !== 'object' || error === null) {
    return message;
  }

  const stderrValue = Reflect.get(error, 'stderr');
  const stderr =
    typeof stderrValue === 'string'
      ? stderrValue.trim()
      : Buffer.isBuffer(stderrValue)
        ? stderrValue.toString('utf8').trim()
        : '';

  return stderr.length > 0 ? `${message}\n${stderr}` : message;
}

async function main() {
  const DatabaseSync = loadDatabaseSync();

  if (!DatabaseSync) {
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-dist-opencode-'));
  const dbPath = path.join(tempDir, 'opencode.db');

  try {
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

      const insert = database.prepare(
        'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
      );
      insert.run(
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

    let output;

    try {
      output = execFileSync(
        process.execPath,
        [
          'dist/index.js',
          'daily',
          '--source',
          'opencode',
          '--opencode-db',
          dbPath,
          '--timezone',
          'UTC',
          '--json',
        ],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      throw new Error(
        `Dist OpenCode smoke check failed while executing dist CLI: ${formatExecError(error)}`,
      );
    }

    const envelope = JSON.parse(output);

    if (envelope.schemaVersion !== 1 || envelope.report !== 'usage') {
      throw new Error(
        `Dist OpenCode smoke check failed: unexpected JSON envelope (${output.trim().slice(0, 120)})`,
      );
    }

    const rows = envelope.data;
    const totalRow = rows.find((row) => row.rowType === 'grand_total');

    if (!totalRow || totalRow.totalTokens !== 15) {
      throw new Error(
        `Dist OpenCode smoke check failed: unexpected grand total (${output.trim()})`,
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

void main();
