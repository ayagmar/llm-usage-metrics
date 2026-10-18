import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { ClaudeSourceAdapter } from '@ayagmar/agent-sessions/sources/claude';
import { PiSourceAdapter } from '@ayagmar/agent-sessions/sources/pi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSelectedAdapters } from '../../src/cli/build-usage-data-parsing.js';
import {
  closeEventStore,
  getFileReadCursor,
  openEventStore,
  replaceFilesEvents,
  type ReplaceFileEventsInput,
} from '../../src/persistence/event-store.js';
import { writeClaudeForkSession } from '../helpers/fork-fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'incremental-ingest-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function at(minute: number): string {
  return new Date(Date.UTC(2026, 4, 1, 10, minute)).toISOString();
}

function claudeAssistant(
  uuid: string,
  minute: number,
  key: string,
  content: unknown[],
  outputTokens: number,
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-1',
    uuid,
    timestamp: at(minute),
    requestId: `req-${key}`,
    message: {
      id: `msg-${key}`,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content,
      usage: { input_tokens: 3, output_tokens: outputTokens, cache_read_input_tokens: 40 },
    },
  });
}

function claudeUser(uuid: string, minute: number, content: unknown): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'session-1',
    uuid,
    timestamp: at(minute),
    cwd: '/work/a',
    message: { role: 'user', content },
  });
}

function toolUse(id: string): unknown[] {
  return [{ type: 'tool_use', id, name: 'Bash', input: {} }];
}

function toolResult(id: string): unknown[] {
  return [{ type: 'tool_result', tool_use_id: id, is_error: false }];
}

/** Streamed rows of one message, calls answered later, a late duplicate and a bad row. */
const CLAUDE_LINES = [
  claudeUser('u1', 0, 'first question'),
  claudeAssistant('a1', 1, '1', toolUse('t1'), 10),
  claudeAssistant('a2', 1, '1', [{ type: 'text', text: 'streamed' }], 20),
  claudeUser('u2', 2, toolResult('t1')),
  claudeAssistant('a3', 3, '2', toolUse('t2'), 5),
  '{"type":"assistant","message":',
  claudeUser('u3', 4, 'second question'),
  claudeAssistant('a4', 2, '3', [{ type: 'text', text: 'stamped earlier' }], 7),
  claudeUser('u4', 5, toolResult('t2')),
  claudeAssistant('a5', 6, '2', [{ type: 'text', text: 'late duplicate' }], 9),
  JSON.stringify({ type: 'ai-title', aiTitle: 'A title', sessionId: 'session-1' }),
  claudeAssistant('a6', 7, '4', toolUse('t3'), 4),
];

function piMessage(minute: number, message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'message', timestamp: at(minute), message });
}

function piAssistant(minute: number, id: string, content: unknown[]): string {
  return piMessage(minute, {
    role: 'assistant',
    responseId: `resp-${id}`,
    content,
    usage: { input: 5, output: 7, cacheRead: 30, cost: { total: 0.001 } },
  });
}

const PI_LINES = [
  JSON.stringify({ type: 'session', id: 'pi-session', timestamp: at(0), cwd: '/work/pi' }),
  JSON.stringify({ type: 'model_change', timestamp: at(1), provider: 'anthropic', modelId: 'm-1' }),
  piMessage(2, { role: 'user', content: 'q1' }),
  piAssistant(3, '1', [{ type: 'toolCall', id: 'c1', name: 'bash' }]),
  piMessage(4, { role: 'toolResult', toolCallId: 'c1', isError: false }),
  piAssistant(5, '2', [{ type: 'text', text: 'answer' }]),
  '{"type":"message","message":',
  JSON.stringify({ type: 'model_change', timestamp: at(6), provider: 'openai', modelId: 'm-2' }),
  piAssistant(7, '3', [{ type: 'toolCall', id: 'c2', name: 'bash' }]),
  JSON.stringify({ type: 'session_info', timestamp: at(8), name: 'pi title' }),
  piMessage(9, { role: 'toolResult', toolCallId: 'c2', isError: true }),
];

const STORED_TABLES = ['events', 'tool_calls', 'messages'] as const;

/** Every stored row of the store's files, in index order, without row ids. */
async function dumpStore(storePath: string): Promise<unknown[]> {
  const store = await openEventStore(storePath);

  try {
    const files = store.database
      .prepare(
        'SELECT id, source, file_path, skipped_rows, skipped_row_reasons FROM files ORDER BY file_path',
      )
      .all();

    return files.map(({ id, ...file }) => ({
      ...file,
      ...Object.fromEntries(
        STORED_TABLES.map((table) => [
          table,
          store.database
            .prepare(`SELECT * FROM ${table} WHERE file_id = ? ORDER BY event_index`)
            .all(id)
            .map((row) =>
              Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'file_id')),
            ),
        ]),
      ),
    }));
  } finally {
    closeEventStore(store);
  }
}

async function readCursorOf(storePath: string, source: string, filePath: string) {
  const store = await openEventStore(storePath);

  try {
    return getFileReadCursor(store, source, filePath);
  } finally {
    closeEventStore(store);
  }
}

type Ingest = {
  storePath: string;
  writes: ReplaceFileEventsInput[];
  run: () => Promise<void>;
};

function createIngest(adapter: SourceAdapter, storePath: string): Ingest {
  const writes: ReplaceFileEventsInput[] = [];
  const spy = vi.fn((...args: Parameters<typeof replaceFilesEvents>) => {
    writes.push(...args[1]);
    replaceFilesEvents(...args);
  });

  return {
    storePath,
    writes,
    run: async () => {
      await parseSelectedAdapters([adapter], 1, {
        eventStore: { enabled: true, path: storePath },
        eventStoreDeps: { replaceFilesEvents: spy },
      });
    },
  };
}

/** The store a first run over the file as it is now writes. */
async function dumpFreshStore(adapter: SourceAdapter, tempDir: string, name: string) {
  const fresh = createIngest(adapter, path.join(tempDir, `${name}.db`));
  await fresh.run();
  return dumpStore(fresh.storePath);
}

async function setTime(filePath: string, seconds: number): Promise<void> {
  await utimes(filePath, seconds, seconds);
}

async function growLineByLine(
  adapter: SourceAdapter,
  tempDir: string,
  filePath: string,
  lines: readonly string[],
): Promise<Ingest> {
  const ingest = createIngest(adapter, path.join(tempDir, 'incremental.db'));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, '');

  for (const [index, line] of lines.entries()) {
    await appendFile(filePath, `${line}\n`);
    await setTime(filePath, 1_700_000_000 + index);
    await ingest.run();

    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, `fresh-${String(index)}`),
    );
  }

  return ingest;
}

describe('incremental ingest', () => {
  it('stores a growing Claude transcript as a first run over each version would', async () => {
    const tempDir = await createTempDir();
    const projectsDir = path.join(tempDir, 'projects');
    const filePath = path.join(projectsDir, 'project-a', 'session-1.jsonl');
    const adapter = new ClaudeSourceAdapter({ dir: projectsDir });

    const ingest = await growLineByLine(adapter, tempDir, filePath, CLAUDE_LINES);

    // The first write reads the whole file; every later one only the appended line.
    expect(ingest.writes).toHaveLength(CLAUDE_LINES.length);
    expect(ingest.writes[0]?.append).toBeUndefined();
    expect(ingest.writes.slice(1).every((write) => write.append !== undefined)).toBe(true);
    expect(await readCursorOf(ingest.storePath, 'claude', filePath)).toMatchObject({
      offset: (await readFile(filePath)).length,
    });
  });

  it('stores a growing pi session as a first run over each version would', async () => {
    const tempDir = await createTempDir();
    const sessionsDir = path.join(tempDir, 'sessions');
    const filePath = path.join(sessionsDir, 'work', 'session.jsonl');
    const adapter = new PiSourceAdapter({ dir: sessionsDir });

    const ingest = await growLineByLine(adapter, tempDir, filePath, PI_LINES);

    expect(ingest.writes.slice(1).every((write) => write.append !== undefined)).toBe(true);
  });

  it('reads a rewritten or truncated file again in full', async () => {
    const tempDir = await createTempDir();
    const projectsDir = path.join(tempDir, 'projects');
    const filePath = path.join(projectsDir, 'project-a', 'session-1.jsonl');
    const adapter = new ClaudeSourceAdapter({ dir: projectsDir });
    const ingest = await growLineByLine(adapter, tempDir, filePath, CLAUDE_LINES.slice(0, 4));

    // Same prefix length, other bytes, then more lines: the stored rows no longer hold.
    const rewritten = (await readFile(filePath, 'utf8')).replace(
      'first question',
      'other question',
    );
    await writeFile(filePath, `${rewritten}${CLAUDE_LINES[4] ?? ''}\n`);
    await setTime(filePath, 1_700_001_000);
    await ingest.run();
    expect(ingest.writes.at(-1)?.append).toBeUndefined();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-rewritten'),
    );

    await writeFile(filePath, `${CLAUDE_LINES[0] ?? ''}\n`);
    await setTime(filePath, 1_700_002_000);
    await ingest.run();
    expect(ingest.writes.at(-1)?.append).toBeUndefined();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-truncated'),
    );
  });

  it('reads a file whose last line is unfinished in full and keeps no cursor', async () => {
    const tempDir = await createTempDir();
    const sessionsDir = path.join(tempDir, 'sessions');
    const filePath = path.join(sessionsDir, 'work', 'session.jsonl');
    const adapter = new PiSourceAdapter({ dir: sessionsDir });
    const ingest = await growLineByLine(adapter, tempDir, filePath, PI_LINES.slice(0, 4));

    // A writer caught mid-line: the line counts once it is finished.
    await appendFile(filePath, PI_LINES[4] ?? '');
    await setTime(filePath, 1_700_001_000);
    await ingest.run();
    expect(await readCursorOf(ingest.storePath, 'pi', filePath)).toBeUndefined();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-partial'),
    );

    await appendFile(filePath, '\n');
    await setTime(filePath, 1_700_002_000);
    await ingest.run();
    expect(ingest.writes.at(-1)?.append).toBeUndefined();
    expect(await readCursorOf(ingest.storePath, 'pi', filePath)).toBeDefined();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-finished'),
    );
  });

  it('reads a fork again in full when its parent changes too', async () => {
    const tempDir = await createTempDir();
    const projectsDir = path.join(tempDir, 'projects');
    const projectDir = path.join(projectsDir, 'project-a');
    const subagentsDir = await writeClaudeForkSession(projectDir);
    const forkPath = path.join(subagentsDir, 'agent-a2.jsonl');
    const parentPath = path.join(projectDir, 'session-1.jsonl');
    const adapter = new ClaudeSourceAdapter({ dir: projectsDir });
    const ingest = createIngest(adapter, path.join(tempDir, 'incremental.db'));
    // The fixture's files end without a line feed; finish them so the fork keeps a cursor.
    await Promise.all([forkPath, parentPath].map((filePath) => appendFile(filePath, '\n')));
    await ingest.run();
    expect(await readCursorOf(ingest.storePath, 'claude', forkPath)).toBeDefined();

    // Grown alone, the fork resumes, though its parent sorts first among its dependencies.
    await appendFile(forkPath, `${claudeAssistant('a8', 8, '8', [], 2)}\n`);
    await setTime(forkPath, 1_700_000_500);
    ingest.writes.length = 0;
    await ingest.run();
    expect(ingest.writes.find((write) => write.filePath === forkPath)?.append).toBeDefined();

    // The parent now holds the fork's own row, so the fork no longer counts it.
    const forkRow = (await readFile(forkPath, 'utf8')).split('\n')[1] ?? '';
    await appendFile(parentPath, `${forkRow}\n`);
    await appendFile(forkPath, `${claudeAssistant('a9', 9, '9', [], 3)}\n`);
    await Promise.all([forkPath, parentPath].map((filePath) => setTime(filePath, 1_700_001_000)));
    ingest.writes.length = 0;
    await ingest.run();

    expect(ingest.writes.find((write) => write.filePath === forkPath)?.append).toBeUndefined();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-fork'),
    );
  });
});
