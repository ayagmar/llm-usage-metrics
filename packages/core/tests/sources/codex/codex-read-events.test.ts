import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { EventKind, SessionEvent } from '../../../src/domain/session-event.js';
import { CodexSourceAdapter } from '../../../src/sources/codex/index.js';
import { createReadDiagnostics } from '../../../src/sources/parse-diagnostics.js';
import type { ReadEventsOptions } from '../../../src/sources/source-adapter.js';
import { collect } from '../../../src/stream/collect.js';
import { readEvents } from '../../../src/stream/read-events.js';
import { fixturePath } from '../../helpers/fixtures.js';
import { assertReadEventsInvariants } from '../../helpers/read-events-invariants.js';
import { canonicalTmpdir } from '../../helpers/tmp.js';

const EVENTS_DIR = fixturePath(import.meta.url, '../../fixtures-events/codex');
const SESSION_EVENTS = path.join(EVENTS_DIR, 'session-events.jsonl');
const TOKEN_COUNT_ONLY = path.join(EVENTS_DIR, 'token-count-only.jsonl');
const HELD_TIMESTAMPS = path.join(EVENTS_DIR, 'held-timestamps.jsonl');

// Rule 1: the core fixtures (forks included), the root e2e fixtures read in place, and the event fixtures.
const CORPUS_ROOTS = [
  fixturePath(import.meta.url, '../../fixtures/codex'),
  fixturePath(import.meta.url, '../../fixtures/codex-fork'),
  fixturePath(import.meta.url, '../../fixtures/codex-fork-parent'),
  fixturePath(import.meta.url, '../../../../../tests/fixtures/e2e/codex'),
  fixturePath(import.meta.url, '../../../../../tests/fixtures/e2e-large/codex'),
  EVENTS_DIR,
];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function writeSession(lines: readonly string[]): Promise<string> {
  const root = await mkdtemp(path.join(canonicalTmpdir(), 'codex-read-events-'));
  tempDirs.push(root);
  const filePath = path.join(root, 'inline-session.jsonl');
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

async function read(
  filePath: string,
  options: Omit<ReadEventsOptions, 'diagnostics'> = {},
): Promise<{ events: SessionEvent[]; reasons: Record<string, number> }> {
  const diagnostics = createReadDiagnostics();
  const events = await collect(
    // A fork's parent is looked up next to it, never under the host's ~/.codex.
    readEvents(new CodexSourceAdapter({ dir: path.dirname(filePath) }), filePath, {
      ...options,
      diagnostics,
    }),
  );
  return { events, reasons: Object.fromEntries(diagnostics.skippedRowReasons) };
}

/**
 * I5 for codex: a usage record takes the session id current when it is flushed (its
 * token_count line, or the end of the file for a token_usage_record no token_count
 * follows); every other event takes the one current at its own record.
 */
function createSessionIdDerivation(filePath: string): (event: SessionEvent) => string {
  const records = readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    });
  const sessionIds: string[] = [];
  let sessionId = path.basename(filePath, '.jsonl');
  let sawSessionMeta = false;
  // A fork keeps its own id; later session_meta lines are copied from its parent.
  let isFork = false;

  for (const record of records) {
    const payload = record?.payload as Record<string, unknown> | undefined;

    if (record?.type === 'session_meta' && !isFork) {
      isFork = !sawSessionMeta && typeof payload?.forked_from_id === 'string';
      sawSessionMeta = true;

      if (typeof payload?.id === 'string' && payload.id.trim()) {
        sessionId = payload.id.trim();
      }
    }

    sessionIds.push(sessionId);
  }

  const keys = records.map((record) => JSON.stringify(record));
  const isTokenCount = (index: number): boolean =>
    records[index]?.type === 'event_msg' &&
    (records[index]?.payload as Record<string, unknown> | undefined)?.type === 'token_count';

  return (event) => {
    const raw = event.kind === 'tool_call' ? (event.raw as { call: unknown }).call : event.raw;
    let index = keys.indexOf(JSON.stringify(raw));

    if (event.kind === 'usage') {
      while (index < records.length - 1 && !isTokenCount(index)) {
        index += 1;
      }
    }

    return sessionIds[index] ?? '';
  };
}

describe('CodexSourceAdapter.readEvents', () => {
  it('declares all four kinds', () => {
    expect(new CodexSourceAdapter().capabilities.kinds).toEqual([
      'usage',
      'message',
      'tool_call',
      'session_meta',
    ]);
  });

  it('yields every kind of a session in completion order, usage in read order', async () => {
    const { events, reasons } = await read(SESSION_EVENTS, { text: true });
    const base = { source: 'codex', sessionId: 'codex-events-session' };

    expect(events).toEqual([
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-10-01T09:00:00.000Z',
        cwd: '/work/demo-repo',
        gitBranch: 'feature/events',
        agentVersion: '0.99.0',
        rawProvider: 'Azure-East',
      },
      // developer → system
      {
        kind: 'message',
        ...base,
        timestamp: '2026-10-01T09:00:00.100Z',
        role: 'system',
        textLength: 73,
        text: '<permissions instructions>sandboxed</permissions instructions>\n\nBe brief.',
      },
      // A user message that is only injected context → system
      {
        kind: 'message',
        ...base,
        timestamp: '2026-10-01T09:00:00.200Z',
        role: 'system',
        textLength: 130,
        text: '# AGENTS.md instructions for /work/demo-repo\n\nUse pnpm.\n\n<environment_context>\n  <cwd>/work/demo-repo</cwd>\n</environment_context>',
      },
      {
        kind: 'session_meta',
        ...base,
        timestamp: '2026-10-01T09:00:01.000Z',
        model: 'gpt-5.5-codex',
      },
      // The event_msg copy of this prompt is ignored.
      {
        kind: 'message',
        ...base,
        timestamp: '2026-10-01T09:00:01.100Z',
        role: 'user',
        textLength: 37,
        text: 'List the files, then search the docs.',
      },
      {
        kind: 'message',
        ...base,
        timestamp: '2026-10-01T09:00:03.000Z',
        role: 'assistant',
        messageId: 'msg-a1',
        model: 'gpt-5.5-codex',
        textLength: 14,
        text: 'Listing files.',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-01T09:00:03.500Z',
        toolCallId: 'call-ls',
        name: 'exec_command',
        status: 'ok',
        completedAt: '2026-10-01T09:00:04.250Z',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-01T09:00:04.000Z',
        toolCallId: 'call-patch',
        name: 'apply_patch',
        status: 'ok',
        completedAt: '2026-10-01T09:00:04.500Z',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-01T09:00:05.000Z',
        name: 'web_search',
        status: 'ok',
        completedAt: '2026-10-01T09:00:05.000Z',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-01T09:00:05.500Z',
        toolCallId: 'ws-2',
        name: 'web_search',
        status: 'error',
        completedAt: '2026-10-01T09:00:05.500Z',
      },
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-01T09:00:05.600Z',
        name: 'web_search',
        status: 'unknown',
      },
      {
        kind: 'usage',
        ...base,
        timestamp: '2026-10-01T09:00:06.000Z',
        repoRoot: '/work/demo-repo',
        provider: 'azure-east',
        model: 'gpt-5.5-codex',
        inputTokens: 1000,
        outputTokens: 80,
        reasoningTokens: 30,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 1280,
        singleRequest: true,
        messageId: 'resp-1',
        rawProvider: 'Azure-East',
      },
      {
        kind: 'message',
        ...base,
        timestamp: '2026-10-01T09:00:07.600Z',
        role: 'assistant',
        model: 'gpt-5.5-codex',
        textLength: 32,
        text: 'Here is the list.\n\nAnd the docs.',
      },
      {
        kind: 'message',
        ...base,
        timestamp: '2026-10-01T09:00:07.700Z',
        role: 'system',
        textLength: 52,
        text: '<turn_aborted>\nThe user interrupted.\n</turn_aborted>',
      },
      // End of file: the unanswered call, then the pending usage record.
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-01T09:00:07.000Z',
        toolCallId: 'call-unanswered',
        name: 'exec_command',
        status: 'unknown',
      },
      {
        kind: 'usage',
        ...base,
        timestamp: '2026-10-01T09:00:08.000Z',
        repoRoot: '/work/demo-repo',
        provider: 'azure-east',
        model: 'gpt-5.5-codex',
        inputTokens: 300,
        outputTokens: 40,
        reasoningTokens: 0,
        cacheReadTokens: 1200,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 1540,
        singleRequest: true,
        messageId: 'resp-2',
        rawProvider: 'Azure-East',
      },
    ]);
    // The repeated call-ls call is a duplicate and its result is dropped; the stray result
    // is an orphan.
    expect(reasons).toEqual({
      json_parse_error: 1,
      invalid_timestamp: 1,
      other_json_parse_error: 1,
      message_unknown_role: 1,
      tool_call_missing_id: 1,
      tool_call_duplicate_id: 1,
      tool_call_orphan_result: 1,
    });
  });

  it('keeps text and titles out unless asked, and attaches raw records when asked', async () => {
    const { events } = await read(SESSION_EVENTS, { raw: true });
    const lines = readFileSync(SESSION_EVENTS, 'utf8').split('\n');
    const record = (index: number): unknown => JSON.parse(lines[index] ?? '');

    for (const event of events) {
      expect(event).not.toHaveProperty('text');
    }

    expect(events.find((event) => event.kind === 'message')).toMatchObject({
      textLength: 73,
      raw: record(1),
    });
    expect(events.filter((event) => event.kind === 'tool_call').map((event) => event.raw)).toEqual([
      { call: record(8), result: record(10) },
      { call: record(9), result: record(11) },
      { call: record(12) },
      { call: record(13) },
      { call: record(14) },
      { call: record(17) },
    ]);
    // A usage record carries the token_usage_record whose tokens it holds.
    expect(events.filter((event) => event.kind === 'usage').map((event) => event.raw)).toEqual([
      record(15),
      record(27),
    ]);
  });

  it('records only the reason codes of the kinds it yields', async () => {
    // The last line is a token_count with a delta and no timestamp: only usage counts it.
    expect((await read(SESSION_EVENTS, { kinds: ['message'] })).reasons).toEqual({
      other_json_parse_error: 2,
      message_unknown_role: 1,
    });
    expect((await read(SESSION_EVENTS, { kinds: ['usage'] })).reasons).toEqual({
      json_parse_error: 1,
      invalid_timestamp: 1,
    });
    await expect(read(SESSION_EVENTS, { kinds: [] })).resolves.toEqual({
      events: [],
      reasons: {},
    });
  });

  it('gives token_count usage no ids and no raw provider when nothing logged them', async () => {
    const { events } = await read(TOKEN_COUNT_ONLY, { raw: true });
    const [first, second] = readFileSync(TOKEN_COUNT_ONLY, 'utf8')
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));

    expect(events).toEqual([
      {
        kind: 'usage',
        source: 'codex',
        sessionId: 'token-count-only',
        timestamp: '2026-10-02T10:00:00.000Z',
        repoRoot: undefined,
        provider: 'openai',
        model: 'legacy-codex-unknown',
        inputTokens: 400,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 520,
        raw: first,
      },
      {
        kind: 'usage',
        source: 'codex',
        sessionId: 'token-count-only',
        timestamp: '2026-10-02T10:00:05.000Z',
        repoRoot: undefined,
        provider: 'openai',
        model: 'legacy-codex-unknown',
        inputTokens: 200,
        outputTokens: 30,
        reasoningTokens: 0,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 430,
        raw: second,
      },
    ]);
  });

  it('takes the raw provider only from a logged session_meta model_provider', async () => {
    const filePath = await writeSession([
      '{"timestamp":"2026-10-04T10:00:00.000Z","type":"session_meta","payload":{"id":"s-no-provider","cwd":"/work/x"}}',
      '{"timestamp":"2026-10-04T10:00:01.000Z","type":"token_usage_record","payload":{"response_id":"resp-x","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
    ]);
    const { events } = await read(filePath);

    expect(events).toEqual([
      {
        kind: 'session_meta',
        source: 'codex',
        sessionId: 's-no-provider',
        timestamp: '2026-10-04T10:00:00.000Z',
        cwd: '/work/x',
      },
      expect.objectContaining({ kind: 'usage', provider: 'openai', messageId: 'resp-x' }),
    ]);
    expect(events[1]).not.toHaveProperty('rawProvider');
  });

  it('gives records without a timestamp the next one seen, ahead of that record', async () => {
    const { events, reasons } = await read(HELD_TIMESTAMPS, { text: true });
    const base = {
      source: 'codex',
      sessionId: 'codex-held-session',
      timestamp: '2026-10-03T08:00:00.000Z',
    };

    expect(events).toEqual([
      { kind: 'session_meta', ...base, cwd: '/work/held', rawProvider: 'openai' },
      // Answered while held: its result completes at the timestamp that releases both.
      {
        kind: 'tool_call',
        ...base,
        toolCallId: 'call-held',
        name: 'exec_command',
        status: 'ok',
        completedAt: base.timestamp,
      },
      { kind: 'message', ...base, role: 'user', textLength: 21, text: 'Before any timestamp.' },
      { kind: 'session_meta', ...base, model: 'gpt-5.5' },
      {
        kind: 'message',
        ...base,
        role: 'assistant',
        model: 'gpt-5.5',
        textLength: 8,
        text: 'Carried.',
      },
      // A web search is its own result, so it completes at its carried timestamp.
      { kind: 'tool_call', ...base, name: 'web_search', status: 'ok', completedAt: base.timestamp },
      // A result with no timestamp of its own completes at the carried one.
      {
        kind: 'tool_call',
        ...base,
        timestamp: '2026-10-03T08:00:05.000Z',
        toolCallId: 'call-timed',
        name: 'exec_command',
        status: 'ok',
        completedAt: '2026-10-03T08:00:05.000Z',
      },
      {
        kind: 'tool_call',
        ...base,
        toolCallId: 'call-held-open',
        name: 'exec_command',
        status: 'unknown',
      },
    ]);
    expect(reasons).toEqual({});
  });

  it('counts records a file never gives a timestamp as <kind>_invalid_timestamp', async () => {
    const filePath = await writeSession([
      '{"type":"session_meta","payload":{"id":"s-untimed","cwd":"/work/untimed"}}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c1"}}',
      '{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":""}}',
      '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"c2"}}',
    ]);

    await expect(read(filePath)).resolves.toEqual({
      events: [],
      reasons: {
        session_meta_invalid_timestamp: 1,
        message_invalid_timestamp: 1,
        tool_call_invalid_timestamp: 2,
      },
    });
  });

  it('skips tool calls without a name and messages without text', async () => {
    const filePath = await writeSession([
      '{"timestamp":"2026-10-04T11:00:00.000Z","type":"response_item","payload":{"type":"function_call","call_id":"c-no-name"}}',
      '{"timestamp":"2026-10-04T11:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:"}]}}',
      '{"timestamp":"2026-10-04T11:00:02.000Z","type":"response_item","payload":{"type":"function_call_output","output":""}}',
      '{"timestamp":"2026-10-04T11:00:03.000Z","type":"response_item"}',
    ]);

    await expect(read(filePath)).resolves.toEqual({
      events: [],
      reasons: { tool_call_missing_name: 1, tool_call_result_missing_id: 1 },
    });
  });

  it('states session facts per session id when a file logs a second session', async () => {
    const filePath = await writeSession([
      '{"timestamp":"2026-10-04T13:00:00.000Z","type":"session_meta","payload":{"id":"s-first","cwd":"/work/shared","cli_version":"0.9.0"}}',
      '{"timestamp":"2026-10-04T13:00:01.000Z","type":"session_meta","payload":{"id":"s-second","cwd":"/work/shared","cli_version":"0.9.0"}}',
    ]);
    const facts = { source: 'codex', cwd: '/work/shared', agentVersion: '0.9.0' };

    await expect(read(filePath)).resolves.toEqual({
      events: [
        {
          kind: 'session_meta',
          ...facts,
          sessionId: 's-first',
          timestamp: '2026-10-04T13:00:00.000Z',
        },
        {
          kind: 'session_meta',
          ...facts,
          sessionId: 's-second',
          timestamp: '2026-10-04T13:00:01.000Z',
        },
      ],
      reasons: {},
    });
  });

  it('skips a message whose role only an object prototype knows', async () => {
    const filePath = await writeSession(
      ['constructor', 'toString', '__proto__'].map(
        (role, index) =>
          `{"timestamp":"2026-10-04T11:30:0${index}.000Z","type":"response_item","payload":{"type":"message","role":"${role}","content":[{"type":"input_text","text":"x"}]}}`,
      ),
    );

    await expect(read(filePath)).resolves.toEqual({
      events: [],
      reasons: { message_unknown_role: 3 },
    });
  });

  it('keeps a user message with a real prompt beside injected context as user', async () => {
    const filePath = await writeSession([
      '{"timestamp":"2026-10-04T12:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context></environment_context>"},{"type":"input_text","text":"Fix the bug."}]}}',
      '{"timestamp":"2026-10-04T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"  <user_instructions>be terse</user_instructions>"}]}}',
    ]);
    const { events } = await read(filePath);

    expect(events.map((event) => (event.kind === 'message' ? event.role : event.kind))).toEqual([
      'user',
      'system',
    ]);
  });

  it('holds I1-I7 over the codex corpus', async () => {
    let files = 0;

    for (const root of CORPUS_ROOTS) {
      const adapter = new CodexSourceAdapter({ dir: root });

      for (const filePath of await adapter.discoverFiles()) {
        await assertReadEventsInvariants(adapter, filePath, {
          deriveSessionId: createSessionIdDerivation(filePath),
        });
        files += 1;
      }
    }

    expect(files).toBe(16);
  });

  it('reads two kinds as the all-kinds read filtered to them', async () => {
    const adapter = new CodexSourceAdapter();
    const all = await collect(adapter.readEvents(SESSION_EVENTS));
    const kinds: readonly EventKind[] = ['message', 'tool_call'];
    const pair = await collect(adapter.readEvents(SESSION_EVENTS, { kinds }));

    expect(pair).toEqual(all.filter((event) => kinds.includes(event.kind)));
  });
});
