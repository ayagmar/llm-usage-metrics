import { expect } from 'vitest';

import {
  createMessageEvent,
  createSessionMetaEvent,
  createToolCallEvent,
  createUsageRecord,
  type SessionEvent,
} from '../../src/domain/session-event.js';
import { createReadDiagnostics } from '../../src/sources/parse-diagnostics.js';
import { getDeclaredKinds, isReadReasonCode } from '../../src/sources/session-event-helpers.js';
import type { ReadEventsOptions, SourceAdapter } from '../../src/sources/source-adapter.js';
import { collect } from '../../src/stream/collect.js';
import { readEvents } from '../../src/stream/read-events.js';

type ReadDiagnosticsSummary = {
  skippedRows: number;
  skippedRowReasons: Record<string, number>;
};

type ReadResult<T> = { events: T[]; diagnostics: ReadDiagnosticsSummary };

export type ReadEventsInvariantOptions = {
  /**
   * I5: the session id an event's own record derives, as the file's usage derives it.
   * Events come from a `{ text: true, raw: true }` read, so `event.raw` is the record
   * when the adapter implements `readEvents`.
   */
  deriveSessionId: (event: SessionEvent) => string;
};

// The keys readEvents adds to a usage event that read yields.
const USAGE_RECORD_KEYS = new Set(['kind', 'messageId', 'requestId', 'rawProvider', 'raw']);

function summarize(diagnostics: ReturnType<typeof createReadDiagnostics>): ReadDiagnosticsSummary {
  return {
    skippedRows: diagnostics.skippedRows,
    skippedRowReasons: Object.fromEntries(diagnostics.skippedRowReasons),
  };
}

/** Restricted to the reason codes `read` records (rule 4). */
function restrictToReadReasons(summary: ReadDiagnosticsSummary): ReadDiagnosticsSummary {
  const entries = Object.entries(summary.skippedRowReasons);
  const readEntries = entries.filter(([reason]) => isReadReasonCode(reason));
  const otherRows = entries
    .filter(([reason]) => !isReadReasonCode(reason))
    .reduce((total, [, count]) => total + count, 0);

  return {
    skippedRows: summary.skippedRows - otherRows,
    skippedRowReasons: Object.fromEntries(readEntries),
  };
}

async function readWith(
  adapter: SourceAdapter,
  filePath: string,
  options: Omit<ReadEventsOptions, 'diagnostics'>,
): Promise<ReadResult<SessionEvent>> {
  const diagnostics = createReadDiagnostics();
  const events = await collect(readEvents(adapter, filePath, { ...options, diagnostics }));
  return { events, diagnostics: summarize(diagnostics) };
}

function recreate(event: SessionEvent): SessionEvent {
  switch (event.kind) {
    case 'usage':
      return createUsageRecord(event);
    case 'message':
      return createMessageEvent(event);
    case 'tool_call':
      return createToolCallEvent(event);
    case 'session_meta':
      return createSessionMetaEvent(event);
  }
}

function withoutRecordKeys(event: SessionEvent): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(event).filter(([key]) => !USAGE_RECORD_KEYS.has(key))),
  );
}

/**
 * Asserts invariants I1–I7 of the readEvents contract for one file of `adapter`. Every
 * failure message starts with the invariant it breaks.
 */
export async function assertReadEventsInvariants(
  adapter: SourceAdapter,
  filePath: string,
  { deriveSessionId }: ReadEventsInvariantOptions,
): Promise<void> {
  const declared = getDeclaredKinds(adapter);
  const readDiagnostics = createReadDiagnostics();
  const readOutput = await collect(adapter.read(filePath, { diagnostics: readDiagnostics }));
  const read = { events: readOutput, diagnostics: summarize(readDiagnostics) };

  // I1: usage-only readEvents is read, plus the record keys.
  const usageOnly = await readWith(adapter, filePath, { kinds: ['usage'] });
  expect(
    usageOnly.events.map((event) => event.kind),
    'I1: a usage-only read yields only usage',
  ).toEqual(read.events.map(() => 'usage'));
  expect(
    usageOnly.events.map(withoutRecordKeys),
    'I1: usage records without the record keys are read events, in order',
  ).toEqual(read.events.map((event) => JSON.stringify(event)));
  expect(usageOnly.diagnostics, 'I1: a usage-only read records what read records').toEqual(
    read.diagnostics,
  );

  // I3: text and raw are opt-in.
  const plain = await readWith(adapter, filePath, {});
  const withText = await readWith(adapter, filePath, { text: true });
  const withRaw = await readWith(adapter, filePath, { raw: true });
  const full = await readWith(adapter, filePath, { text: true, raw: true });

  for (const { events, text, raw } of [
    { events: plain.events, text: false, raw: false },
    { events: withText.events, text: true, raw: false },
    { events: withRaw.events, text: false, raw: true },
  ]) {
    for (const event of events) {
      if (!text) {
        expect(event, 'I3: no text key without text').not.toHaveProperty('text');
        expect(event, 'I3: no title key without text').not.toHaveProperty('title');
      }

      if (!raw) {
        expect(event, 'I3: no raw key without raw').not.toHaveProperty('raw');
      }
    }
  }

  // I4: only declared kinds.
  for (const event of [...plain.events, ...full.events]) {
    expect(declared, `I4: ${event.kind} is a declared kind`).toContain(event.kind);
  }

  // I2: a one-kind read is the all-kinds read filtered to that kind.
  for (const kind of declared) {
    const single = await readWith(adapter, filePath, { kinds: [kind], text: true, raw: true });
    expect(single.events, `I2: a ${kind}-only read is the all-kinds read filtered`).toStrictEqual(
      full.events.filter((event) => event.kind === kind),
    );
  }

  // I5: every event's session id is its record's usage derivation.
  for (const event of full.events) {
    expect(event.sessionId, `I5: the ${event.kind} event's session id`).toBe(
      deriveSessionId(event),
    );
  }

  // I6: every event is what its constructor makes of it.
  for (const event of full.events) {
    expect(recreate(event), `I6: the ${event.kind} event re-created`).toStrictEqual(event);
  }

  // I7: an all-kinds read records read's reasons as read does.
  for (const { diagnostics } of [plain, full]) {
    expect(
      restrictToReadReasons(diagnostics),
      "I7: an all-kinds read restricted to read's reasons",
    ).toEqual(read.diagnostics);
  }
}
