import { describe, expect, it } from 'vitest';

import {
  createMessageEvent,
  createUsageRecord,
  type SessionEvent,
} from '../../src/domain/session-event.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import { createReadDiagnostics, recordSkippedRow } from '../../src/sources/parse-diagnostics.js';
import type { ReadEventsOptions, SourceAdapter } from '../../src/sources/source-adapter.js';
import { collect } from '../../src/stream/collect.js';
import { readEvents } from '../../src/stream/read-events.js';

const usage = {
  source: 'qwen',
  sessionId: 'session-1',
  timestamp: '2026-06-01T10:00:00.000Z',
  model: 'qwen3-coder',
  inputTokens: 4,
  outputTokens: 2,
};

// A usage-only adapter with no readEvents; `capabilities` as given.
function createReadOnlyAdapter(capabilities?: SourceAdapter['capabilities']): SourceAdapter {
  return {
    id: 'qwen',
    capabilities,
    discoverFiles: async () => [],
    async *read(_filePath, options) {
      if (options?.diagnostics) {
        recordSkippedRow(options.diagnostics, 'no_token_usage');
      }

      yield createUsageEvent(usage);
      yield createUsageEvent({ ...usage, inputTokens: 9 });
    },
  };
}

describe('readEvents', () => {
  it("falls back to read: each event becomes a usage record, read's keys in read's order", async () => {
    const adapter = createReadOnlyAdapter({ kinds: ['usage'] });
    const records = await collect(readEvents(adapter, '/f.jsonl'));
    const events = await collect(adapter.read('/f.jsonl'));

    expect(records).toStrictEqual(events.map((event) => createUsageRecord(event)));
    expect(records.map(({ kind, ...rest }) => `${kind} ${JSON.stringify(rest)}`)).toEqual(
      events.map((event) => `usage ${JSON.stringify(event)}`),
    );
  });

  it('records the diagnostics read records', async () => {
    const diagnostics = createReadDiagnostics();

    await collect(
      readEvents(createReadOnlyAdapter({ kinds: ['usage'] }), '/f.jsonl', { diagnostics }),
    );

    expect(diagnostics.skippedRows).toBe(1);
    expect([...diagnostics.skippedRowReasons]).toEqual([['no_token_usage', 1]]);
  });

  it('treats an adapter without declared kinds as usage-only', async () => {
    for (const adapter of [createReadOnlyAdapter(), createReadOnlyAdapter({})]) {
      await expect(collect(readEvents(adapter, '/f.jsonl'))).resolves.toHaveLength(2);
      await expect(
        collect(readEvents(adapter, '/f.jsonl', { kinds: ['message', 'tool_call'] })),
      ).resolves.toEqual([]);
    }
  });

  it('yields nothing, and does not read, when usage is not requested', async () => {
    const diagnostics = createReadDiagnostics();
    const adapter = createReadOnlyAdapter({ kinds: ['usage'] });

    for (const kinds of [[], ['message'], ['session_meta', 'tool_call']] as const) {
      await expect(
        collect(readEvents(adapter, '/f.jsonl', { kinds, diagnostics })),
      ).resolves.toEqual([]);
    }

    expect(diagnostics.skippedRows).toBe(0);
  });

  it('attaches no raw record, ids or raw provider in the fallback', async () => {
    const [record] = await collect(
      readEvents(createReadOnlyAdapter({ kinds: ['usage'] }), '/f.jsonl', {
        raw: true,
        text: true,
      }),
    );

    for (const key of ['raw', 'messageId', 'requestId', 'rawProvider']) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("uses the adapter's own readEvents, passing the options through", async () => {
    const received: (ReadEventsOptions | undefined)[] = [];
    const message = createMessageEvent({ ...usage, role: 'user', textLength: 0 });
    const adapter: SourceAdapter = {
      ...createReadOnlyAdapter({ kinds: ['usage', 'message'] }),
      async *readEvents(_filePath, options): AsyncGenerator<SessionEvent> {
        received.push(options);
        yield message;
      },
    };
    const options: ReadEventsOptions = { kinds: ['message'], text: true };

    await expect(collect(readEvents(adapter, '/f.jsonl', options))).resolves.toEqual([message]);
    await expect(collect(readEvents(adapter, '/f.jsonl'))).resolves.toEqual([message]);
    expect(received).toEqual([options, {}]);
  });
});
