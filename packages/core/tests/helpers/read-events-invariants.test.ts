import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  EVENT_KINDS,
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  type EventKind,
  type SessionEvent,
} from '../../src/domain/session-event.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createReadDiagnostics, recordSkippedRow } from '../../src/sources/parse-diagnostics.js';
import { QwenSourceAdapter } from '../../src/sources/qwen/index.js';
import {
  createKindEvent,
  recordKindSkippedRow,
  resolveReadKinds,
} from '../../src/sources/session-event-helpers.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';
import { collect } from '../../src/stream/collect.js';
import { fixturePath } from './fixtures.js';
import { assertReadEventsInvariants } from './read-events-invariants.js';

type Row =
  | { type: 'meta'; session: string; ts: string; cwd: string; title: string }
  | { type: 'message'; session: string; ts: string; text: string }
  | { type: 'tool'; session: string; ts: string; id: string; name: string }
  | { type: 'usage'; session: string; ts: string; tokens: number; id: string }
  | { type: 'usage_without_tokens'; session: string; ts: string }
  | { type: 'message_without_role'; session: string; ts: string };

const ROWS: readonly Row[] = [
  { type: 'meta', session: 's1', ts: '2026-06-01T10:00:00Z', cwd: '/repo', title: 'Title' },
  { type: 'message', session: 's1', ts: '2026-06-01T10:00:01Z', text: 'hello' },
  { type: 'tool', session: 's1', ts: '2026-06-01T10:00:02Z', id: 'call-1', name: 'Bash' },
  { type: 'usage', session: 's1', ts: '2026-06-01T10:00:03Z', tokens: 10, id: 'msg-1' },
  { type: 'usage_without_tokens', session: 's1', ts: '2026-06-01T10:00:04Z' },
  { type: 'message_without_role', session: 's1', ts: '2026-06-01T10:00:05Z' },
  { type: 'usage', session: 's2', ts: '2026-06-01T10:00:06Z', tokens: 20, id: 'msg-2' },
];

type Plant = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

/** An adapter with all four kinds over `ROWS`, breaking the invariant `plant` names. */
function createFakeAdapter(plant?: Plant): SourceAdapter {
  const declared: readonly EventKind[] =
    plant === 'I4' ? ['usage', 'message', 'session_meta'] : EVENT_KINDS;

  return {
    id: 'fake',
    capabilities: { kinds: declared },
    discoverFiles: async () => [],
    async *read(_filePath, options) {
      for (const row of ROWS) {
        if (row.type === 'usage_without_tokens' && options?.diagnostics) {
          recordSkippedRow(options.diagnostics, 'no_token_usage');
        }

        if (row.type === 'usage') {
          yield createUsageEvent({
            source: 'fake',
            sessionId: row.session,
            timestamp: row.ts,
            inputTokens: row.tokens,
          });
        }
      }
    },
    async *readEvents(_filePath, options = {}): AsyncGenerator<SessionEvent> {
      const diagnostics = options.diagnostics ?? createReadDiagnostics();
      // The I4 plant reads every kind by default, declared or not.
      const kinds = resolveReadKinds(options.kinds, plant === 'I4' ? EVENT_KINDS : declared);
      const text = options.text === true || plant === 'I3';

      if (plant === 'I2' && options.kinds?.length === 1 && options.kinds[0] === 'message') {
        return;
      }

      if (plant === 'I7' && options.kinds === undefined) {
        recordSkippedRow(diagnostics, 'invalid_timestamp');
      }

      for (const row of ROWS) {
        const raw = options.raw ? row : undefined;
        const base = { source: 'fake', sessionId: row.session, timestamp: row.ts, raw };
        let event: SessionEvent | undefined;

        switch (row.type) {
          case 'meta':
            event = createKindEvent(diagnostics, kinds, 'session_meta', () =>
              createSessionMetaEvent({
                ...base,
                cwd: row.cwd,
                title: text ? row.title : undefined,
              }),
            );
            break;
          case 'message':
            event = createKindEvent(diagnostics, kinds, 'message', () => {
              const message = createMessageEvent({
                ...base,
                sessionId: plant === 'I5' ? 'not-its-session' : row.session,
                role: 'user',
                textLength: row.text.length,
                text: text ? row.text : undefined,
              });
              // A model that skipped the constructor's normalization.
              return plant === 'I6' ? { ...message, model: 'Not-Normalized' } : message;
            });
            break;
          case 'tool':
            event = createKindEvent(diagnostics, kinds, 'tool_call', () =>
              createToolCallEvent({ ...base, toolCallId: row.id, name: row.name, status: 'ok' }),
            );
            break;
          case 'usage':
            if (kinds.has('usage')) {
              const record = createUsageRecord({
                ...base,
                inputTokens: row.tokens,
                messageId: row.id,
              });
              // The same fields with the session id moved last.
              const { sessionId, ...rest } = record;
              event = plant === 'I1' ? { ...rest, sessionId } : record;
            }
            break;
          case 'usage_without_tokens':
            if (kinds.has('usage')) {
              recordSkippedRow(diagnostics, 'no_token_usage');
            }
            break;
          case 'message_without_role':
            recordKindSkippedRow(diagnostics, kinds, 'message', 'invalid_role');
            break;
        }

        if (event) {
          yield event;
        }
      }
    },
  };
}

function deriveFakeSessionId(event: SessionEvent): string {
  return (event.raw as Row).session;
}

describe('assertReadEventsInvariants', () => {
  it('passes an adapter that keeps the contract', async () => {
    await assertReadEventsInvariants(createFakeAdapter(), '/fake.jsonl', {
      deriveSessionId: deriveFakeSessionId,
    });
  });

  it.each(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7'] as const)(
    'fails an adapter that breaks %s, naming it',
    async (plant) => {
      await expect(
        assertReadEventsInvariants(createFakeAdapter(plant), '/fake.jsonl', {
          deriveSessionId: deriveFakeSessionId,
        }),
      ).rejects.toThrow(new RegExp(`^${plant}: `, 'u'));
    },
  );

  it('passes qwen through the read fallback', async () => {
    const projectsDir = fixturePath(import.meta.url, '../fixtures/qwen/projects');
    const filePath = fixturePath(
      import.meta.url,
      '../fixtures/qwen/projects/demo/chats/usage.jsonl',
    );
    // Fallback events carry no raw record, so the derivation is keyed by timestamp: each
    // line's own session id, else the project-and-file fallback.
    const sessionByTimestamp = new Map<string, string>();

    for (const line of (await readFile(filePath, 'utf8')).split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as { timestamp: string; sessionId: string };
      const timestamp = new Date(record.timestamp);

      if (!Number.isNaN(timestamp.getTime())) {
        sessionByTimestamp.set(timestamp.toISOString(), record.sessionId.trim() || 'demo-usage');
      }
    }

    const adapter = new QwenSourceAdapter({ dir: projectsDir });

    await assertReadEventsInvariants(adapter, filePath, {
      deriveSessionId: (event) => sessionByTimestamp.get(event.timestamp) ?? '',
    });
    // The corpus is not vacuous: the fixture yields usage and records skipped rows.
    const diagnostics = createReadDiagnostics();
    const events = await collect(adapter.read(filePath, { diagnostics }));

    expect(events.length).toBeGreaterThan(1);
    expect(diagnostics.skippedRows).toBeGreaterThan(0);
  });
});
