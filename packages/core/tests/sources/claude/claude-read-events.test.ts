import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../src/domain/session-event.js';
import { asRecord } from '../../../src/utils/as-record.js';
import { ClaudeSourceAdapter } from '../../../src/sources/claude/index.js';
import { createReadDiagnostics } from '../../../src/sources/parse-diagnostics.js';
import type { ReadEventsOptions } from '../../../src/sources/source-adapter.js';
import { collect } from '../../../src/stream/collect.js';
import { readEvents } from '../../../src/stream/read-events.js';
import { fixturePath } from '../../helpers/fixtures.js';
import { assertReadEventsInvariants } from '../../helpers/read-events-invariants.js';

const eventsDir = fixturePath(import.meta.url, '../../fixtures-events/claude');
const forkDir = path.join(eventsDir, 'fork');

// Rule 1: the root claude fixtures read in place, each with `dir` at its fixture root, and
// the readEvents fixtures.
const corpusRoots = [
  fixturePath(import.meta.url, '../../../../../tests/fixtures/golden/claude/continued-session'),
  fixturePath(import.meta.url, '../../../../../tests/fixtures/golden/claude/long-context'),
  fixturePath(import.meta.url, '../../../../../tests/fixtures/e2e/claude'),
  eventsDir,
  forkDir,
];

async function readFixture(
  file: string,
  options: Omit<ReadEventsOptions, 'diagnostics'> = {},
  dir = eventsDir,
): Promise<{ events: SessionEvent[]; reasons: Record<string, number> }> {
  const diagnostics = createReadDiagnostics();
  const events = await collect(
    readEvents(new ClaudeSourceAdapter({ dir }), path.join(dir, file), {
      ...options,
      diagnostics,
    }),
  );
  return { events, reasons: Object.fromEntries(diagnostics.skippedRowReasons) };
}

/** The usage derivation applied to an event's own row: its sessionId, else the file name. */
function deriveSessionId(filePath: string): (event: SessionEvent) => string {
  return (event) => {
    const raw = asRecord(event.raw);
    const row = event.kind === 'tool_call' ? asRecord(raw?.call) : raw;
    const sessionId = row?.sessionId;
    return typeof sessionId === 'string' ? sessionId : path.basename(filePath, '.jsonl');
  };
}

const usageTokens = {
  inputTokens: 10,
  outputTokens: 4,
  reasoningTokens: 0,
  cacheReadTokens: 3,
  cacheWriteTokens: 2,
  cacheWrite1hTokens: 0,
  totalTokens: 19,
};

function usage(
  sessionId: string,
  timestamp: string,
  messageId: string,
  requestId: string,
  tokens: Partial<typeof usageTokens> = {},
): SessionEvent {
  return {
    kind: 'usage',
    source: 'claude',
    sessionId,
    timestamp,
    repoRoot: '/work/demo',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    ...usageTokens,
    ...tokens,
    costUsd: undefined,
    messageId,
    requestId,
  };
}

describe('ClaudeSourceAdapter.readEvents', () => {
  it('declares all four kinds', () => {
    expect(new ClaudeSourceAdapter().capabilities.kinds).toEqual([
      'usage',
      'message',
      'tool_call',
      'session_meta',
    ]);
  });

  it('maps a transcript to messages, tool calls, session facts and usage', async () => {
    const { events, reasons } = await readFixture('session-events.jsonl', { text: true });
    const session = { source: 'claude', sessionId: 'evt-session' } as const;

    expect(events).toStrictEqual([
      // The custom title has no timestamp and waits for the first row that has one.
      {
        kind: 'session_meta',
        ...session,
        timestamp: '2026-07-01T10:00:00.000Z',
        title: 'Demo task',
      },
      {
        kind: 'session_meta',
        ...session,
        timestamp: '2026-07-01T10:00:00.000Z',
        cwd: '/work/demo',
        gitBranch: 'main',
        agentVersion: '2.1.0',
      },
      {
        kind: 'message',
        ...session,
        timestamp: '2026-07-01T10:00:00.000Z',
        role: 'user',
        textLength: 13,
        text: 'Fix the build',
      },
      // The AI title after a custom one and the isMeta row yield nothing; of the split
      // response, only the text row is a message.
      {
        kind: 'message',
        ...session,
        timestamp: '2026-07-01T10:00:03.000Z',
        role: 'assistant',
        textLength: 18,
        messageId: 'msg-1',
        model: 'claude-sonnet-4-5',
        text: 'Running the tests.',
      },
      {
        kind: 'tool_call',
        ...session,
        timestamp: '2026-07-01T10:00:04.000Z',
        name: 'Bash',
        status: 'ok',
        toolCallId: 'tool-1',
        completedAt: '2026-07-01T10:00:09.000Z',
        durationMs: 4500,
        messageId: 'msg-1',
      },
      // The repeated result for tool-2 is dropped; the one for tool-unknown is an orphan.
      {
        kind: 'tool_call',
        ...session,
        timestamp: '2026-07-01T10:00:10.000Z',
        name: 'Read',
        status: 'error',
        toolCallId: 'tool-2',
        completedAt: '2026-07-01T10:00:11.000Z',
        messageId: 'msg-2',
      },
      {
        kind: 'session_meta',
        ...session,
        timestamp: '2026-07-01T10:00:14.000Z',
        gitBranch: 'feature',
      },
      {
        kind: 'session_meta',
        ...session,
        timestamp: '2026-07-01T10:00:15.000Z',
        gitBranch: 'main',
      },
      // Text blocks join around the image; the second row with the same uuid is dropped.
      {
        kind: 'message',
        ...session,
        timestamp: '2026-07-01T10:00:15.000Z',
        role: 'user',
        textLength: 23,
        text: 'First part\n\nSecond part',
      },
      {
        kind: 'message',
        ...session,
        timestamp: '2026-07-01T10:00:17.000Z',
        role: 'system',
        textLength: 35,
        text: 'Summary of the earlier conversation',
      },
      // The synthetic row yields no message. Unanswered calls come at the end of the
      // file, before the usage.
      {
        kind: 'tool_call',
        ...session,
        timestamp: '2026-07-01T10:00:14.000Z',
        name: 'Grep',
        status: 'unknown',
        toolCallId: 'tool-3',
        messageId: 'msg-3',
      },
      // The split response counts once, with the last row's usage.
      usage('evt-session', '2026-07-01T10:00:04.000Z', 'msg-1', 'req-1', {
        outputTokens: 40,
        totalTokens: 55,
      }),
      usage('evt-session', '2026-07-01T10:00:10.000Z', 'msg-2', 'req-2'),
      usage('evt-session', '2026-07-01T10:00:14.000Z', 'msg-3', 'req-3'),
      // The provider this row logs is kept as logged.
      {
        ...usage('evt-session', '2026-07-01T10:00:21.000Z', 'msg-5', 'req-5'),
        rawProvider: 'Anthropic',
      },
    ]);
    expect(reasons).toEqual({
      synthetic_message: 1,
      invalid_assistant_message: 1,
      json_parse_error: 1,
      other_json_parse_error: 1,
      message_invalid_user_message: 1,
      message_invalid_assistant_message: 1,
      tool_call_invalid_assistant_message: 1,
      tool_call_invalid_tool_use: 1,
      tool_call_invalid_tool_result: 1,
      tool_call_orphan_result: 1,
    });
  });

  it('records only the reasons of the kinds it reads', async () => {
    expect((await readFixture('session-events.jsonl', { kinds: ['message'] })).reasons).toEqual({
      other_json_parse_error: 2,
      message_invalid_user_message: 1,
      message_invalid_assistant_message: 1,
    });
    expect((await readFixture('session-events.jsonl', { kinds: [] })).events).toEqual([]);
  });

  it('yields titles held for a timestamp when the next timestamped row is processed', async () => {
    // The first timestamped row is an assistant row holding only a tool_use, which yields
    // nothing itself: the held titles come out at that row, ahead of everything else.
    const { events, reasons } = await readFixture('held-title.jsonl', { text: true });
    const session = {
      source: 'claude',
      sessionId: 'held-session',
      timestamp: '2026-07-02T09:00:00.000Z',
    } as const;

    expect(events).toStrictEqual([
      { kind: 'session_meta', ...session, title: 'Early title' },
      { kind: 'session_meta', ...session, title: 'Named session' },
      {
        kind: 'session_meta',
        ...session,
        cwd: '/work/demo',
        gitBranch: 'main',
        agentVersion: '2.1.0',
      },
      {
        kind: 'tool_call',
        ...session,
        name: 'Bash',
        status: 'ok',
        toolCallId: 'h-tool-1',
        completedAt: '2026-07-02T09:00:05.000Z',
        messageId: 'h-msg-1',
      },
      usage('held-session', '2026-07-02T09:00:00.000Z', 'h-msg-1', 'h-req-1'),
    ]);
    expect(reasons).toEqual({});
  });

  it('counts titles in a file without any timestamp as invalid', async () => {
    expect(await readFixture('untimed-titles.jsonl', { text: true })).toEqual({
      events: [],
      reasons: { session_meta_invalid_timestamp: 2 },
    });
  });

  it('skips fork rows replayed from the parent for every kind', async () => {
    const { events, reasons } = await readFixture(
      'fork-session/subagents/agent-f1.jsonl',
      {},
      forkDir,
    );

    // A row with a parent uuid but a message key the parent lacks: usage keeps it (it keys
    // replays on the message key), the other kinds skip it (they also key on the uuid).
    // The parent's spawning call, re-logged under a new uuid, is skipped by its message
    // key, so its result in the fork's directive row is an orphan.
    expect(events.map((event) => [event.kind, event.timestamp])).toEqual([
      ['session_meta', '2026-07-03T08:00:04.000Z'],
      ['message', '2026-07-03T08:00:04.000Z'],
      ['message', '2026-07-03T08:01:00.000Z'],
      ['message', '2026-07-03T08:01:01.000Z'],
      ['usage', '2026-07-03T08:00:02.000Z'],
      ['usage', '2026-07-03T08:01:01.000Z'],
    ]);
    expect(reasons).toEqual({ tool_call_orphan_result: 1 });
  });

  it('attaches the source rows only when raw is requested', async () => {
    const { events } = await readFixture('held-title.jsonl', { kinds: ['tool_call'], raw: true });
    const raw = asRecord(events[0]?.raw);

    expect(asRecord(raw?.call)?.uuid).toBe('h-a-1');
    expect(asRecord(raw?.result)?.uuid).toBe('h-u-1');

    const unanswered = await readFixture('session-events.jsonl', {
      kinds: ['tool_call'],
      raw: true,
    });
    expect(unanswered.events.at(-1)?.raw).toEqual({
      call: expect.objectContaining({ uuid: 'a-5' }) as unknown,
    });
  });

  it('holds the readEvents invariants over the claude corpus', async () => {
    let files = 0;

    for (const root of corpusRoots) {
      const adapter = new ClaudeSourceAdapter({ dir: root });

      for (const filePath of await adapter.discoverFiles()) {
        await assertReadEventsInvariants(adapter, filePath, {
          deriveSessionId: deriveSessionId(filePath),
        });
        files += 1;
      }
    }

    expect(files).toBeGreaterThanOrEqual(10);
  });
});
