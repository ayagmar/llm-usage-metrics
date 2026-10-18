import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SourceAdapter } from '@ayagmar/agent-sessions';
import { ClaudeSourceAdapter } from '@ayagmar/agent-sessions/sources/claude';
import { PiSourceAdapter } from '@ayagmar/agent-sessions/sources/pi';
import { QwenSourceAdapter } from '@ayagmar/agent-sessions/sources/qwen';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSelectedAdapters } from '../../src/cli/build-usage-data-parsing.js';
import {
  closeEventStore,
  getFileReadCursor,
  openEventStore,
  type EventStore,
  replaceFilesEvents,
  type ReplaceFileEventsInput,
} from '../../src/persistence/event-store.js';
import { writeClaudeForkSession } from '../helpers/fork-fixtures.js';

const tempDirs: string[] = [];
const tempStores: EventStore[] = [];

afterEach(async () => {
  tempStores.splice(0).forEach(closeEventStore);
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

// Discovery stores each file under its real path (macOS /private/var, Windows long names),
// so the tests name files by it too.
async function createTempDir(): Promise<string> {
  const tempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'incremental-ingest-')));
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

function qwenAssistant(minute: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'qwen-session',
    timestamp: at(minute),
    model: 'qwen3-coder',
    usageMetadata: { promptTokenCount: 60, candidatesTokenCount: outputTokens },
  });
}

const QWEN_LINES = [
  JSON.stringify({ type: 'user', sessionId: 'qwen-session', timestamp: at(0) }),
  qwenAssistant(1, 20),
  '{"type":"assistant","usageMetadata":',
  qwenAssistant(2, 30),
  qwenAssistant(3, 40),
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
  /** The output tokens the run reports, and its warnings. */
  run: (deps?: {
    getFileReadCursor?: typeof getFileReadCursor;
  }) => Promise<{ outputTokens: number; warnings: string[] }>;
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
    run: async (deps) => {
      const result = await parseSelectedAdapters([adapter], 1, {
        eventStore: { enabled: true, path: storePath },
        eventStoreDeps: { replaceFilesEvents: spy, ...deps },
      });
      return {
        outputTokens: result.successfulParseResults
          .flatMap((parseResult) => parseResult.events)
          .reduce((sum, event) => sum + event.outputTokens, 0),
        warnings: result.warnings,
      };
    },
  };
}

/** The store a first run over the file as it is now writes. */
async function dumpFreshStore(adapter: SourceAdapter, tempDir: string, name: string) {
  const fresh = createIngest(adapter, path.join(tempDir, `${name}.db`));
  await fresh.run();
  return dumpStore(fresh.storePath);
}

/** A second connection to the store, as another report running at the same time. */
async function openOtherRun(storePath: string): Promise<EventStore> {
  const store = await openEventStore(storePath);
  tempStores.push(store);
  return store;
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

    // The first run keeps no cursor, the first growth reads the whole file under one, and
    // every later run reads only the appended line.
    expect(ingest.writes).toHaveLength(CLAUDE_LINES.length);
    expect(ingest.writes[0]?.readCursor).toBeUndefined();
    expect(ingest.writes[1]?.readCursor).toBeDefined();
    expect(ingest.writes[1]?.append).toBeUndefined();
    expect(ingest.writes.slice(2).every((write) => write.append !== undefined)).toBe(true);
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

    expect(ingest.writes.slice(2).every((write) => write.append !== undefined)).toBe(true);
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
    await ingest.run();
    // The fixture's files end without a line feed. Finishing the fork's last line is the
    // growth that gives it a cursor; the parent's first, so the fork's read follows alone.
    await appendFile(parentPath, '\n');
    await setTime(parentPath, 1_700_000_000);
    await ingest.run();
    await appendFile(forkPath, '\n');
    await setTime(forkPath, 1_700_000_000);
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
  it('stores a growing qwen chat as a first run over each version would', async () => {
    const tempDir = await createTempDir();
    const projectsDir = path.join(tempDir, 'projects');
    const filePath = path.join(projectsDir, 'demo', 'chats', 'chat.jsonl');
    const adapter = new QwenSourceAdapter({ dir: projectsDir });

    const ingest = await growLineByLine(adapter, tempDir, filePath, QWEN_LINES);

    expect(ingest.writes.slice(2).every((write) => write.append !== undefined)).toBe(true);
  });

  it.each([
    ['grows', true],
    ['keeps its size', false],
  ])(
    'reads a file again in full when a line far from both ends of the read changes and it %s',
    async (_label, grows) => {
      const tempDir = await createTempDir();
      const sessionsDir = path.join(tempDir, 'sessions');
      const filePath = path.join(sessionsDir, 'work', 'session.jsonl');
      const adapter = new PiSourceAdapter({ dir: sessionsDir });
      const padding = JSON.stringify({ type: 'padding', data: 'x'.repeat(100_000) });
      const ingest = await growLineByLine(adapter, tempDir, filePath, [
        PI_LINES[0] ?? '',
        padding,
        piMessage(3, { role: 'assistant', usage: { input: 10, output: 1 } }),
        padding,
        piMessage(4, { role: 'assistant', usage: { input: 20, output: 1 } }),
      ]);

      const rewritten = (await readFile(filePath, 'utf8')).replace('"input":10', '"input":99');
      const appended = grows
        ? `${piMessage(5, { role: 'assistant', usage: { input: 30, output: 1 } })}\n`
        : '';
      await writeFile(filePath, `${rewritten}${appended}`);
      await setTime(filePath, 1_700_001_000);
      await ingest.run();

      expect(ingest.writes.at(-1)?.append).toBeUndefined();
      expect(await dumpStore(ingest.storePath)).toEqual(
        await dumpFreshStore(adapter, tempDir, 'fresh-rewritten'),
      );
    },
  );

  it('reports a grown file once when another run stores it during the lookup', async () => {
    const tempDir = await createTempDir();
    const projectsDir = path.join(tempDir, 'projects');
    const filePath = path.join(projectsDir, 'project-a', 'session-1.jsonl');
    const adapter = new ClaudeSourceAdapter({ dir: projectsDir });
    const lines = [1, 2, 3].map((index) =>
      claudeAssistant(`a${String(index)}`, index, String(index), [], 10),
    );
    const ingest = await growLineByLine(adapter, tempDir, filePath, lines.slice(0, 2));
    await appendFile(filePath, `${lines[2] ?? ''}\n`);
    await setTime(filePath, 1_700_001_000);

    // The other run reads the same grown file and stores the appended line.
    const otherStorePath = path.join(tempDir, 'other.db');
    await copyFile(ingest.storePath, otherStorePath);
    const other = createIngest(adapter, otherStorePath);
    await other.run();
    expect(other.writes[0]?.append).toBeDefined();
    const otherRun = await openOtherRun(ingest.storePath);

    // It commits to this run's store just after this run read the stored cursor.
    const reported = await ingest.run({
      getFileReadCursor: (store, source, readPath) => {
        const cursor = getFileReadCursor(store, source, readPath);
        replaceFilesEvents(otherRun, other.writes);
        return cursor;
      },
    });

    expect(reported.outputTokens).toBe(30);
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-raced'),
    );
  });

  it('skips a resumed append when another run stored the same version past its cursor', async () => {
    const tempDir = await createTempDir();
    const projectsDir = path.join(tempDir, 'projects');
    const filePath = path.join(projectsDir, 'project-a', 'session-1.jsonl');
    const adapter = new ClaudeSourceAdapter({ dir: projectsDir });
    const lines = [1, 2, 3, 4, 5].map((index) =>
      claudeAssistant(`a${String(index)}`, index, String(index), [], 10),
    );
    // Two runs: the first keeps no cursor, the second keeps one at two lines.
    const ingest = await growLineByLine(adapter, tempDir, filePath, lines.slice(0, 2));
    const atTwoLines = ingest.writes.at(-1);
    expect(atTwoLines?.readCursor).toBeDefined();

    // Another run took the file's stat at two lines, but its read reached the third: it
    // stores three lines' rows under the two-line fingerprint, with no cursor.
    await appendFile(filePath, `${lines[2] ?? ''}\n`);
    const threeLines = createIngest(adapter, path.join(tempDir, 'three.db'));
    await threeLines.run();
    const threeLinesWrite = threeLines.writes.at(0);

    if (!atTwoLines || !threeLinesWrite) {
      throw new Error('both runs must store the file');
    }

    const staleWrite: ReplaceFileEventsInput = {
      ...threeLinesWrite,
      fingerprint: atTwoLines.fingerprint,
      readCursor: undefined,
    };
    const otherRun = await openOtherRun(ingest.storePath);

    // This run resumes from the two-line cursor; the other run commits meanwhile.
    await appendFile(filePath, `${lines[3] ?? ''}\n`);
    await setTime(filePath, 1_700_001_000);
    await ingest.run({
      getFileReadCursor: (store, source, readPath) => {
        const cursor = getFileReadCursor(store, source, readPath);
        replaceFilesEvents(otherRun, [staleWrite]);
        return cursor;
      },
    });

    await appendFile(filePath, `${lines[4] ?? ''}\n`);
    await setTime(filePath, 1_700_002_000);
    await ingest.run();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-raced'),
    );
  });
  it('reads a file again in full, store on, when its stored fingerprint does not parse', async () => {
    const tempDir = await createTempDir();
    const sessionsDir = path.join(tempDir, 'sessions');
    const filePath = path.join(sessionsDir, 'work', 'session.jsonl');
    const adapter = new PiSourceAdapter({ dir: sessionsDir });
    const ingest = await growLineByLine(adapter, tempDir, filePath, PI_LINES.slice(0, 4));
    const store = await openEventStore(ingest.storePath);

    try {
      store.database.prepare("UPDATE files SET fingerprint = '{'").run();
    } finally {
      closeEventStore(store);
    }

    await appendFile(filePath, `${PI_LINES[4] ?? ''}\n`);
    await setTime(filePath, 1_700_001_000);
    const { warnings } = await ingest.run();

    expect(warnings).toEqual([]);
    expect(ingest.writes.at(-1)?.append).toBeUndefined();
    expect(await dumpStore(ingest.storePath)).toEqual(
      await dumpFreshStore(adapter, tempDir, 'fresh-unparsed'),
    );
  });
});
