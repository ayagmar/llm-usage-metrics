import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../src/domain/session-event.js';
import { createReadDiagnostics } from '../../../src/sources/parse-diagnostics.js';
import { normalizeTimestampCandidate } from '../../../src/sources/parsing-utils.js';
import { PiSourceAdapter } from '../../../src/sources/pi/index.js';
import type { ReadEventsOptions } from '../../../src/sources/source-adapter.js';
import { collect } from '../../../src/stream/collect.js';
import { readEvents } from '../../../src/stream/read-events.js';
import { fixturePath } from '../../helpers/fixtures.js';
import { assertReadEventsInvariants } from '../../helpers/read-events-invariants.js';

const eventsRoot = fixturePath(import.meta.url, '../../fixtures-events/pi');
const sessionDir = path.join(eventsRoot, 'session');
const sessionFile = path.join(sessionDir, '2026-03-01T10-00-00-000Z_pi-events-1.jsonl');
const forkCountedDir = path.join(eventsRoot, 'fork-counted');
const forkCountedFile = path.join(forkCountedDir, '2026-03-02T09-10-00-000Z_pi-fork-a.jsonl');
const forkUncountedDir = path.join(eventsRoot, 'fork-uncounted');
const forkUncountedFile = path.join(forkUncountedDir, '2026-03-02T09-10-00-000Z_pi-fork-b.jsonl');
const timestampsDir = path.join(eventsRoot, 'timestamps');

async function readPiEvents(dir: string, filePath: string, options: ReadEventsOptions = {}) {
  const diagnostics = createReadDiagnostics();
  const events = await collect(
    readEvents(new PiSourceAdapter({ dir }), filePath, { ...options, diagnostics }),
  );
  return { events, reasons: Object.fromEntries(diagnostics.skippedRowReasons) };
}

const base = { source: 'pi', sessionId: 'pi-events-1' } as const;

describe('PiSourceAdapter.readEvents', () => {
  it('reads every kind of a session, with text', async () => {
    const { events, reasons } = await readPiEvents(sessionDir, sessionFile, { text: true });

    expect(events).toEqual([
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-03-01T10:00:00.000Z',
        cwd: '/work/demo',
      },
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-03-01T10:00:01.000Z',
        model: 'claude-sonnet-4-5',
        rawProvider: 'Anthropic',
      },
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-03-01T10:00:02.000Z',
        title: 'Demo session',
      },
      // Image blocks are left out of the joined text.
      {
        kind: 'message',
        ...base,
        timestamp: '2026-03-01T10:00:03.000Z',
        role: 'user',
        textLength: 38,
        text: 'List the files.\n\nThen check the build.',
      },
      // Thinking blocks are left out; the message completes at its record, before usage.
      {
        kind: 'message',
        ...base,
        timestamp: '2026-03-01T10:00:05.000Z',
        role: 'assistant',
        messageId: 'resp-1',
        model: 'claude-sonnet-4-5',
        textLength: 12,
        text: 'I will look.',
      },
      {
        kind: 'usage',
        ...base,
        timestamp: '2026-03-01T10:00:05.000Z',
        repoRoot: '/work/demo',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 0,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        cacheWrite1hTokens: 0,
        totalTokens: 165,
        singleRequest: true,
        costUsd: 0.002,
        messageId: 'resp-1',
        rawProvider: 'anthropic',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-03-01T10:00:05.000Z',
        toolCallId: 'call-1',
        name: 'read',
        status: 'ok',
        completedAt: '2026-03-01T10:00:06.000Z',
        durationMs: 12,
        messageId: 'resp-1',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-03-01T10:00:05.000Z',
        toolCallId: 'call-2',
        name: 'bash',
        status: 'error',
        completedAt: '2026-03-01T10:00:07.000Z',
        messageId: 'resp-1',
      },
      // A record with only tool calls is no message; no responseId gives no messageId.
      {
        kind: 'usage',
        ...base,
        timestamp: '2026-03-01T10:00:10.000Z',
        repoRoot: '/work/demo',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        inputTokens: 50,
        outputTokens: 10,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 60,
        singleRequest: true,
        costUsd: undefined,
        rawProvider: 'anthropic',
      },
      {
        kind: 'message',
        ...base,
        timestamp: '2026-03-01T10:00:13.000Z',
        role: 'system',
        textLength: 14,
        text: 'Tools changed.',
      },
      // The repeated model_change states nothing new; the next one changes the model only.
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-03-01T10:00:17.000Z',
        model: 'claude-opus-4-1',
      },
      // Text is joined unaltered; zero usage gives a message and no usage record.
      {
        kind: 'message',
        ...base,
        timestamp: '2026-03-01T10:00:18.000Z',
        role: 'assistant',
        messageId: 'resp-3',
        model: 'claude-opus-4-1',
        textLength: 18,
        text: 'Done.\n\n Two files.',
      },
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-03-01T10:00:19.000Z',
        title: 'Demo session renamed',
      },
      // Never answered: flushed at end of file.
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-03-01T10:00:10.000Z',
        toolCallId: 'call-3',
        name: 'grep',
        status: 'unknown',
      },
    ]);
    expect(reasons).toEqual({
      json_parse_error: 1,
      other_json_parse_error: 1,
      no_token_usage: 1,
      tool_call_missing_id: 1,
      // call-4 has no name, so it is never started and its result is an orphan.
      tool_call_missing_name: 1,
      tool_call_duplicate_id: 1,
      tool_call_orphan_result: 2,
      tool_call_result_missing_id: 1,
    });
  });

  it('leaves titles and text out unless asked, and keeps textLength', async () => {
    const { events } = await readPiEvents(sessionDir, sessionFile);

    expect(events.filter((event) => event.kind === 'session_meta')).toHaveLength(3);
    expect(events.some((event) => 'title' in event || 'text' in event)).toBe(false);
    expect(events.flatMap((event) => (event.kind === 'message' ? [event.textLength] : []))).toEqual(
      [38, 12, 14, 18],
    );
  });

  it('attaches the source records as raw', async () => {
    const lines = (await readFile(sessionFile, 'utf8'))
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((line) => line !== undefined);
    const byId = (id: string) => lines.find((line) => line.id === id);

    const { events } = await readPiEvents(sessionDir, sessionFile, {
      kinds: ['usage', 'tool_call'],
      raw: true,
    });

    expect(events.map((event) => [event.kind, event.raw])).toEqual([
      ['usage', byId('e05')],
      ['tool_call', { call: byId('e05'), result: byId('e06') }],
      ['tool_call', { call: byId('e05'), result: byId('e07') }],
      ['usage', byId('e10')],
      ['tool_call', { call: byId('e10') }],
    ]);
  });

  it('yields nothing for an empty kinds list', async () => {
    const { events, reasons } = await readPiEvents(sessionDir, sessionFile, { kinds: [] });

    expect(events).toEqual([]);
    expect(reasons).toEqual({});
  });

  it('records no usage reasons and no tool-call reasons when neither is requested', async () => {
    const { reasons } = await readPiEvents(sessionDir, sessionFile, { kinds: ['message'] });

    expect(reasons).toEqual({ other_json_parse_error: 2 });
  });

  it('skips every kind copied from a parent the read counts', async () => {
    const { events, reasons } = await readPiEvents(forkCountedDir, forkCountedFile);

    expect(events.map((event) => [event.kind, event.sessionId, event.timestamp])).toEqual([
      ['session_meta', 'pi-fork-a', '2026-03-02T09:10:00.000Z'],
      ['message', 'pi-fork-a', '2026-03-02T09:10:01.000Z'],
      ['message', 'pi-fork-a', '2026-03-02T09:10:02.000Z'],
      ['usage', 'pi-fork-a', '2026-03-02T09:10:02.000Z'],
      ['tool_call', 'pi-fork-a', '2026-03-02T09:10:02.000Z'],
    ]);
    // The parent is named by its session id, not its path.
    expect(events[0]).toEqual({
      kind: 'session_meta',
      source: 'pi',
      sessionId: 'pi-fork-a',
      timestamp: '2026-03-02T09:10:00.000Z',
      cwd: '/work/demo',
      parentSessionId: 'pi-parent-a',
    });
    expect(reasons).toEqual({});
  });

  it("labels every kind copied from an uncounted parent with the parent's session id", async () => {
    const { events, reasons } = await readPiEvents(forkUncountedDir, forkUncountedFile);

    expect(events.map((event) => [event.kind, event.sessionId, event.timestamp])).toEqual([
      ['session_meta', 'pi-fork-b', '2026-03-02T09:10:00.000Z'],
      ['session_meta', 'pi-parent-b', '2026-03-02T09:00:01.000Z'],
      ['message', 'pi-parent-b', '2026-03-02T09:00:02.000Z'],
      ['message', 'pi-parent-b', '2026-03-02T09:00:03.000Z'],
      ['usage', 'pi-parent-b', '2026-03-02T09:00:03.000Z'],
      ['tool_call', 'pi-parent-b', '2026-03-02T09:00:03.000Z'],
      ['message', 'pi-fork-b', '2026-03-02T09:10:01.000Z'],
      ['message', 'pi-fork-b', '2026-03-02T09:10:02.000Z'],
      ['usage', 'pi-fork-b', '2026-03-02T09:10:02.000Z'],
      ['tool_call', 'pi-fork-b', '2026-03-02T09:10:02.000Z'],
    ]);
    expect(events[1]).toEqual({
      kind: 'session_meta',
      source: 'pi',
      sessionId: 'pi-parent-b',
      timestamp: '2026-03-02T09:00:01.000Z',
      model: 'gpt-5',
      rawProvider: 'openai',
    });
    expect(reasons).toEqual({});
  });

  it('holds a record without a timestamp until the session header supplies one', async () => {
    const { events } = await readPiEvents(
      timestampsDir,
      path.join(timestampsDir, '2026-03-03T08-00-00-000Z_pi-carry.jsonl'),
    );

    expect(events).toEqual([
      {
        kind: 'session_meta',
        source: 'pi',
        sessionId: 'pi-carry',
        timestamp: '2026-03-03T08:00:00.000Z',
        model: 'gpt-5',
        rawProvider: 'openai',
      },
      {
        kind: 'session_meta',
        source: 'pi',
        sessionId: 'pi-carry',
        timestamp: '2026-03-03T08:00:00.000Z',
        cwd: '/work/carry',
      },
      {
        kind: 'message',
        source: 'pi',
        sessionId: 'pi-carry',
        timestamp: '2026-03-03T08:00:00.000Z',
        role: 'user',
        textLength: 24,
      },
    ]);
  });

  it('counts each kind of a file with no valid timestamp as invalid', async () => {
    const { events, reasons } = await readPiEvents(
      timestampsDir,
      path.join(timestampsDir, '2026-03-03T09-00-00-000Z_pi-none.jsonl'),
    );

    expect(events).toEqual([]);
    expect(reasons).toEqual({
      invalid_timestamp: 1,
      session_meta_invalid_timestamp: 1,
      message_invalid_timestamp: 1,
      tool_call_invalid_timestamp: 1,
    });
  });

  it('counts an untimed title only when the read yields text', async () => {
    const file = path.join(timestampsDir, '2026-03-03T09-00-00-000Z_pi-none.jsonl');
    const withText = await readPiEvents(timestampsDir, file, {
      kinds: ['session_meta'],
      text: true,
    });
    const withoutText = await readPiEvents(timestampsDir, file, { kinds: ['session_meta'] });

    expect(withText.reasons).toEqual({ session_meta_invalid_timestamp: 2 });
    expect(withoutText.reasons).toEqual({ session_meta_invalid_timestamp: 1 });
  });
});

// Rule 1: the core pi fixtures, the root e2e pi fixtures read in place, and the new ones.
const repoFixtures = fixturePath(import.meta.url, '../../../../../tests/fixtures');
const corpus: { dir: string; file: string }[] = [
  {
    dir: fixturePath(import.meta.url, '../../fixtures/pi'),
    file: 'session-mixed.jsonl',
  },
  { dir: path.join(repoFixtures, 'e2e/pi'), file: 'session.jsonl' },
  { dir: sessionDir, file: path.basename(sessionFile) },
  { dir: forkCountedDir, file: '2026-03-02T09-00-00-000Z_pi-parent-a.jsonl' },
  { dir: forkCountedDir, file: path.basename(forkCountedFile) },
  { dir: forkUncountedDir, file: path.basename(forkUncountedFile) },
  { dir: timestampsDir, file: '2026-03-03T08-00-00-000Z_pi-carry.jsonl' },
  { dir: timestampsDir, file: '2026-03-03T09-00-00-000Z_pi-none.jsonl' },
];

/** The usage derivation of a pi file, applied to an event's own record. */
async function createSessionIdDerivation(filePath: string) {
  const header = (await readFile(filePath, 'utf8'))
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((line) => line?.type === 'session');
  const sessionId = typeof header?.id === 'string' ? header.id : path.basename(filePath, '.jsonl');
  const forkedAt =
    typeof header?.parentSession === 'string'
      ? normalizeTimestampCandidate(header.timestamp)
      : undefined;
  const parentId =
    typeof header?.parentSession === 'string'
      ? path.basename(header.parentSession, '.jsonl').split('_').at(-1)
      : undefined;

  return (event: SessionEvent): string => {
    const raw = event.raw as Record<string, unknown>;
    const record = (event.kind === 'tool_call' ? raw.call : raw) as Record<string, unknown>;
    const message = record.message as Record<string, unknown> | undefined;
    const timestamp =
      normalizeTimestampCandidate(record.timestamp) ??
      normalizeTimestampCandidate(message?.timestamp) ??
      event.timestamp;
    const copied = forkedAt !== undefined && Date.parse(timestamp) < Date.parse(forkedAt);
    return copied && parentId ? parentId : sessionId;
  };
}

describe('PiSourceAdapter.readEvents invariants', () => {
  it.each(corpus)('holds I1-I7 for $file', async ({ dir, file }) => {
    const filePath = path.join(dir, file);

    await assertReadEventsInvariants(new PiSourceAdapter({ dir }), filePath, {
      deriveSessionId: await createSessionIdDerivation(filePath),
    });
  });
});
