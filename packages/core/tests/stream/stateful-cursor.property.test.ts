import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EventKind } from '../../src/domain/session-event.js';
import { ClaudeSourceAdapter } from '../../src/sources/claude/index.js';
import { createReadDiagnostics, recordSkippedRows } from '../../src/sources/parse-diagnostics.js';
import { PiSourceAdapter } from '../../src/sources/pi/index.js';
import type { SourceAdapter, SourceReadDiagnostics } from '../../src/sources/source-adapter.js';
import { createSourceContext } from '../../src/sources/source-context.js';
import type { ReadCursor, ReplacedEventCounts } from '../../src/stream/cursor.js';
import { readEvents } from '../../src/stream/read-events.js';
import { fixturePath } from '../helpers/fixtures.js';
import { mulberry32, pick, randomInt, type Random } from '../helpers/seeded-random.js';

// A resumed read of a stateful adapter (claude, pi) must leave the caller with what one
// full read gives: per kind, the events of the read before the cursor minus the ones the
// resumed read replaces, then the resumed read's events, in full-read order; and the
// skipped rows of both reads. Checked for every claude and pi fixture split at every line
// boundary, and for seeded synthetic transcripts with the shapes that carry state across
// lines (streamed rows of one message, calls waiting for results, repeated ids, rows
// without timestamps).

const context = createSourceContext({
  homeDir: path.join(os.tmpdir(), 'stateful-cursor-no-home'),
  env: {},
});

type AdapterFactory = (root: string) => SourceAdapter;

const createClaude: AdapterFactory = (root) => new ClaudeSourceAdapter({ dir: root, context });
const createPi: AdapterFactory = (root) => new PiSourceAdapter({ dir: root, context });

type Read = {
  name: string;
  run: (
    adapter: SourceAdapter,
    filePath: string,
    diagnostics: SourceReadDiagnostics,
    resume?: Parameters<typeof readEvents>[2] extends infer O
      ? O extends { resume?: infer R }
        ? R
        : never
      : never,
  ) => AsyncIterable<{ kind: EventKind }>;
};

const READS: Read[] = [
  {
    name: 'read',
    run: async function* (adapter, filePath, diagnostics, resume) {
      for await (const event of adapter.read(filePath, { diagnostics, resume })) {
        yield { kind: 'usage', ...event };
      }
    },
  },
  {
    name: 'readEvents',
    run: (adapter, filePath, diagnostics, resume) =>
      readEvents(adapter, filePath, { diagnostics, resume }),
  },
  {
    name: 'readEvents as the event store reads',
    run: (adapter, filePath, diagnostics, resume) =>
      readEvents(adapter, filePath, {
        kinds: ['usage', 'message', 'tool_call'],
        diagnostics,
        resume,
      }),
  },
  {
    name: 'readEvents with text and raw',
    run: (adapter, filePath, diagnostics, resume) =>
      readEvents(adapter, filePath, { text: true, raw: true, diagnostics, resume }),
  },
];

type KindEvents = Map<EventKind, string[]>;

function byKind(events: readonly { kind: EventKind }[]): KindEvents {
  const grouped: KindEvents = new Map();

  for (const event of events) {
    const list = grouped.get(event.kind) ?? [];
    list.push(JSON.stringify(event));
    grouped.set(event.kind, list);
  }

  return grouped;
}

function sortedEntries(grouped: KindEvents): Array<[EventKind, string[]]> {
  return [...grouped].filter(([, list]) => list.length > 0).sort(([a], [b]) => (a < b ? -1 : 1));
}

function diagnosticsOf(diagnostics: SourceReadDiagnostics) {
  return {
    skippedRows: diagnostics.skippedRows,
    reasons: [...diagnostics.skippedRowReasons].sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

type ResumedRead = {
  events: { kind: EventKind }[];
  diagnostics: SourceReadDiagnostics;
  restarted?: boolean;
  replaced?: ReplacedEventCounts;
  cursor?: ReadCursor;
};

async function readOnce(
  read: Read,
  adapter: SourceAdapter,
  filePath: string,
  from?: ReadCursor,
): Promise<ResumedRead> {
  const result: ResumedRead = { events: [], diagnostics: createReadDiagnostics() };

  for await (const event of read.run(adapter, filePath, result.diagnostics, {
    from,
    onStart: (info) => {
      result.restarted = info.restarted;
      result.replaced = info.replaced;
    },
    onCursor: ({ cursor }) => {
      result.cursor = cursor;
    },
  })) {
    result.events.push(event);
  }

  return result;
}

async function readFull(read: Read, adapter: SourceAdapter, filePath: string) {
  const diagnostics = createReadDiagnostics();
  const events: { kind: EventKind }[] = [];

  for await (const event of read.run(adapter, filePath, diagnostics)) {
    events.push(event);
  }

  return { events: byKind(events), diagnostics };
}

/** What a caller keeps: the kept events minus the replaced ones, then the new read's. */
function keep(kept: KindEvents, next: ResumedRead): KindEvents {
  if (next.restarted !== false) {
    return byKind(next.events);
  }

  const result: KindEvents = new Map();

  for (const [kind, list] of kept) {
    result.set(kind, list.slice(0, list.length - (next.replaced?.[kind] ?? 0)));
  }

  for (const [kind, list] of byKind(next.events)) {
    result.set(kind, [...(result.get(kind) ?? []), ...list]);
  }

  return result;
}

function lineBoundaries(content: Buffer): number[] {
  const boundaries = [0];

  for (let index = content.indexOf(0x0a); index !== -1; index = content.indexOf(0x0a, index + 1)) {
    boundaries.push(index + 1);
  }

  return boundaries;
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function copyRoot(root: string): Promise<string> {
  const copy = await mkdtemp(path.join(os.tmpdir(), 'stateful-cursor-'));
  tempDirs.push(copy);
  await cp(root, copy, { recursive: true });
  return copy;
}

type SplitStats = { resumed: number; restarted: number };

/**
 * Writes each prefix of `relativePath` under a copy of `root`, reads it, writes the whole
 * file, resumes, and checks the result against one full read. Returns how many resumed
 * reads restarted.
 */
async function checkEverySplit(
  createAdapter: AdapterFactory,
  root: string,
  relativePath: string,
  content?: Buffer,
): Promise<SplitStats> {
  const copy = await copyRoot(root);
  const filePath = path.join(copy, relativePath);
  const whole = content ?? (await readFile(filePath));
  const stats: SplitStats = { resumed: 0, restarted: 0 };

  await writeFile(filePath, whole);

  for (const read of READS) {
    const full = await readFull(read, createAdapter(copy), filePath);

    for (const boundary of lineBoundaries(whole)) {
      const label = `${relativePath} ${read.name} split at byte ${String(boundary)}`;
      await writeFile(filePath, whole.subarray(0, boundary));
      const first = await readOnce(read, createAdapter(copy), filePath);
      await writeFile(filePath, whole);
      const second = await readOnce(read, createAdapter(copy), filePath, first.cursor);

      expect(first.restarted, label).toBe(true);
      expect(sortedEntries(keep(byKind(first.events), second)), label).toEqual(
        sortedEntries(full.events),
      );

      const diagnostics = createReadDiagnostics();
      if (second.restarted === false) {
        recordSkippedRows(diagnostics, first.diagnostics);
      }
      recordSkippedRows(diagnostics, second.diagnostics);
      expect(diagnosticsOf(diagnostics), label).toEqual(diagnosticsOf(full.diagnostics));
      expect(second.cursor?.offset, label).toBe(whole.length);

      if (second.restarted) {
        stats.restarted += 1;
      } else {
        stats.resumed += 1;
      }
    }
  }

  return stats;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

const repoFixture = (...segments: string[]) =>
  fixturePath(import.meta.url, '../../../../tests/fixtures', ...segments);
const coreFixture = (...segments: string[]) => fixturePath(import.meta.url, '..', ...segments);

const FIXTURE_ROOTS: Array<[string, AdapterFactory, string]> = [
  ['claude e2e', createClaude, repoFixture('e2e/claude')],
  ['claude golden continued-session', createClaude, repoFixture('golden/claude/continued-session')],
  ['claude golden long-context', createClaude, repoFixture('golden/claude/long-context')],
  ['claude tools', createClaude, repoFixture('tools/claude')],
  ['claude events', createClaude, coreFixture('fixtures-events/claude')],
  ['pi e2e', createPi, repoFixture('e2e/pi')],
  ['pi tools', createPi, repoFixture('tools/pi')],
  ['pi parsing', createPi, coreFixture('fixtures/pi')],
  ['pi events session', createPi, coreFixture('fixtures-events/pi/session')],
  ['pi events timestamps', createPi, coreFixture('fixtures-events/pi/timestamps')],
  ['pi events fork-counted', createPi, coreFixture('fixtures-events/pi/fork-counted')],
  ['pi events fork-uncounted', createPi, coreFixture('fixtures-events/pi/fork-uncounted')],
];

describe('resuming a stateful read at every line boundary of a fixture', () => {
  it.each(FIXTURE_ROOTS)(
    '%s',
    async (_name, createAdapter, root) => {
      const files = await listJsonlFiles(root);
      expect(files.length).toBeGreaterThan(0);
      let resumed = 0;

      for (const file of files) {
        resumed += (await checkEverySplit(createAdapter, root, file)).resumed;
      }

      // The resumed path is what is under test, not only the restart.
      expect(resumed).toBeGreaterThan(0);
    },
    120_000,
  );
});

describe('chaining a resume after every line of the large pi fixture', () => {
  it('equals one full read, and never restarts', async () => {
    const copy = await copyRoot(repoFixture('e2e-large/pi'));
    const filePath = path.join(copy, 'session-large.jsonl');
    const whole = await readFile(filePath);
    const read = READS[2];
    const full = await readFull(read, createPi(copy), filePath);
    const adapter = createPi(copy);
    const diagnostics = createReadDiagnostics();
    let kept: KindEvents = new Map();
    let cursor: ReadCursor | undefined;
    let restarts = 0;

    // Line batches of varying size, every boundary a resume point.
    const boundaries = lineBoundaries(whole).filter((_, index) => index % 7 === 0);
    boundaries.push(whole.length);
    await writeFile(filePath, '');

    for (const boundary of boundaries) {
      await writeFile(filePath, whole.subarray(0, boundary));
      const next = await readOnce(read, adapter, filePath, cursor);
      restarts += next.restarted === true && cursor !== undefined ? 1 : 0;
      kept = keep(kept, next);
      recordSkippedRows(diagnostics, next.diagnostics);
      cursor = next.cursor;
    }

    expect(restarts).toBe(0);
    expect(sortedEntries(kept)).toEqual(sortedEntries(full.events));
    expect(diagnosticsOf(diagnostics)).toEqual(diagnosticsOf(full.diagnostics));
  }, 120_000);
});

// Seeded synthetic transcripts.

function timestampAt(random: Random, base: number, step: number): string {
  // Now and then a row is stamped a little earlier than the one before it.
  const jitter = random() < 0.05 ? -30_000 : 0;
  return new Date(base + step * 10_000 + jitter).toISOString();
}

function claudeTranscript(random: Random): string {
  const lines: string[] = [];
  const sessionId = 'synthetic-session';
  const waiting: string[] = [];
  const usedUuids: string[] = [];
  const usedKeys: Array<{ id: string; requestId: string }> = [];
  const base = Date.parse('2026-05-01T10:00:00.000Z');
  let step = 0;

  const push = (row: Record<string, unknown>) => {
    lines.push(JSON.stringify(row));
  };
  const timestamp = () => (random() < 0.06 ? undefined : timestampAt(random, base, step++));
  const uuid = () => {
    if (usedUuids.length > 0 && random() < 0.04) {
      return pick(random, usedUuids);
    }
    const id = `u-${String(step)}-${String(randomInt(random, 1e6))}`;
    usedUuids.push(id);
    return id;
  };

  for (let turn = 0; turn < 12; turn += 1) {
    const roll = random();

    if (roll < 0.05) {
      lines.push('{"type":"assistant","message":');
      continue;
    }

    if (roll < 0.1) {
      push({
        type: random() < 0.5 ? 'ai-title' : 'custom-title',
        aiTitle: 'A',
        customTitle: 'B',
        sessionId,
      });
      continue;
    }

    push({
      type: 'user',
      sessionId,
      uuid: uuid(),
      timestamp: timestamp(),
      cwd: random() < 0.2 ? '/work/b' : '/work/a',
      message: { role: 'user', content: `question ${String(turn)}` },
    });

    const key =
      usedKeys.length > 0 && random() < 0.05
        ? pick(random, usedKeys)
        : { id: `msg-${String(turn)}`, requestId: `req-${String(turn)}` };
    usedKeys.push(key);
    const streamedRows = 1 + randomInt(random, 3);

    for (let row = 0; row < streamedRows; row += 1) {
      const callId =
        random() < 0.08 && waiting.length > 0 ? waiting[0] : `toolu-${String(turn)}-${String(row)}`;
      const usesTool = random() < 0.5;
      push({
        type: 'assistant',
        sessionId,
        uuid: uuid(),
        timestamp: timestamp(),
        requestId: key.requestId,
        message: {
          id: key.id,
          role: 'assistant',
          model: random() < 0.05 ? '<synthetic>' : 'claude-sonnet-4-5',
          content: usesTool
            ? [{ type: 'tool_use', id: callId, name: 'Bash', input: {} }]
            : [{ type: 'text', text: `answer ${String(row)}` }],
          usage: {
            input_tokens: 1 + randomInt(random, 50),
            output_tokens: 10 * (row + 1),
            cache_read_input_tokens: randomInt(random, 1000),
          },
        },
      });

      if (usesTool) {
        waiting.push(callId);
      }
    }

    // Answer some waiting calls, now and then a call nobody made.
    while (waiting.length > 0 && random() < 0.6) {
      const callId = random() < 0.1 ? `orphan-${String(turn)}` : (waiting.shift() ?? '');
      push({
        type: 'user',
        sessionId,
        uuid: uuid(),
        timestamp: timestamp(),
        toolUseResult: { durationMs: 5 },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId, is_error: random() < 0.2 }],
        },
      });
    }
  }

  return `${lines.join('\n')}\n`;
}

function piTranscript(random: Random): string {
  const lines: string[] = [];
  const waiting: string[] = [];
  const base = Date.parse('2026-05-01T10:00:00.000Z');
  let step = 0;

  const push = (row: Record<string, unknown>) => {
    lines.push(JSON.stringify(row));
  };
  const timestamp = () => (random() < 0.06 ? undefined : timestampAt(random, base, step++));

  if (random() < 0.15) {
    push({ type: 'message', message: { role: 'user', content: 'before the header' } });
  }

  push({ type: 'session', id: 'pi-synthetic', timestamp: timestamp(), cwd: '/work/pi' });

  for (let turn = 0; turn < 14; turn += 1) {
    const roll = random();

    if (roll < 0.08) {
      push({
        type: 'model_change',
        timestamp: timestamp(),
        provider: 'anthropic',
        modelId: `m-${String(turn % 3)}`,
      });
      continue;
    }

    if (roll < 0.12) {
      push({ type: 'session_info', timestamp: timestamp(), name: `title ${String(turn)}` });
      continue;
    }

    if (roll < 0.15) {
      lines.push('{"type":"message","message":');
      continue;
    }

    push({
      type: 'message',
      timestamp: timestamp(),
      message: { role: 'user', content: `q ${String(turn)}` },
    });

    const callId = random() < 0.08 && waiting.length > 0 ? waiting[0] : `call-${String(turn)}`;
    const usesTool = random() < 0.5;
    push({
      type: 'message',
      timestamp: timestamp(),
      message: {
        role: 'assistant',
        responseId: `resp-${String(turn)}`,
        content: usesTool
          ? [{ type: 'toolCall', id: callId, name: 'bash' }]
          : [{ type: 'text', text: `a ${String(turn)}` }],
        usage: {
          input: 1 + randomInt(random, 50),
          output: 7,
          cacheRead: randomInt(random, 300),
          cost: { total: 0.001 },
        },
      },
    });

    if (usesTool) {
      waiting.push(callId);
    }

    while (waiting.length > 0 && random() < 0.6) {
      const resultId = random() < 0.1 ? `orphan-${String(turn)}` : (waiting.shift() ?? '');
      push({
        type: 'message',
        timestamp: timestamp(),
        message: { role: 'toolResult', toolCallId: resultId, isError: random() < 0.2 },
      });
    }
  }

  return `${lines.join('\n')}\n`;
}

const SYNTHETIC_SEEDS = 12;

describe('resuming a stateful read of a synthetic transcript at every line boundary', () => {
  it.each([
    ['claude', createClaude, 'project/session.jsonl', claudeTranscript],
    ['pi', createPi, 'project/2026-05-01T10-00-00-000Z_pi-synthetic.jsonl', piTranscript],
  ] as const)(
    '%s',
    async (_name, createAdapter, relativePath, generate) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'stateful-cursor-synthetic-'));
      tempDirs.push(root);
      await mkdir(path.join(root, 'project'));
      const totals: SplitStats = { resumed: 0, restarted: 0 };

      for (let seed = 1; seed <= SYNTHETIC_SEEDS; seed += 1) {
        const content = Buffer.from(generate(mulberry32(seed)));
        const stats = await checkEverySplit(createAdapter, root, relativePath, content);
        totals.resumed += stats.resumed;
        totals.restarted += stats.restarted;
      }

      // Restarts are the conflicts the state cannot settle (a repeated id, a held row);
      // most splits must resume.
      expect(totals.resumed).toBeGreaterThan(totals.restarted * 2);
    },
    240_000,
  );
});
