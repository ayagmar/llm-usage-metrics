import { describe, expect, it } from 'vitest';

import { EVENT_KINDS, type EventKind } from '../../src/domain/session-event.js';
import { createReadDiagnostics, toParseDiagnostics } from '../../src/sources/parse-diagnostics.js';
import {
  SessionMetaTracker,
  TimestampCarry,
  ToolCallPairing,
  createKindEvent,
  getDeclaredKinds,
  isReadReasonCode,
  joinTextBlocks,
  recordKindSkippedRow,
  recordMalformedLine,
  resolveReadKinds,
} from '../../src/sources/session-event-helpers.js';
import type { SourceReadDiagnostics } from '../../src/sources/source-adapter.js';

const ALL = new Set<EventKind>(EVENT_KINDS);
const USAGE = new Set<EventKind>(['usage']);

function reasons(diagnostics: SourceReadDiagnostics) {
  const { skippedRows, skippedRowReasons } = toParseDiagnostics(
    [],
    diagnostics.skippedRows,
    diagnostics.skippedRowReasons,
  );
  return { skippedRows, skippedRowReasons };
}

describe('kinds', () => {
  it('treats an adapter without declared kinds as usage-only', () => {
    expect(getDeclaredKinds({})).toEqual(['usage']);
    expect(getDeclaredKinds({ capabilities: {} })).toEqual(['usage']);
    expect(getDeclaredKinds({ capabilities: { kinds: EVENT_KINDS } })).toBe(EVENT_KINDS);
  });

  it('reads every declared kind by default and only declared kinds on request', () => {
    expect([...resolveReadKinds(undefined, ['usage', 'message'])]).toEqual(['usage', 'message']);
    expect([...resolveReadKinds(['message', 'tool_call'], ['usage', 'message'])]).toEqual([
      'message',
    ]);
    expect(resolveReadKinds([], EVENT_KINDS).size).toBe(0);
  });
});

describe('reason codes', () => {
  it("defines read's codes as those without a non-usage prefix", () => {
    for (const code of ['json_parse_error', 'no_token_usage', 'invalid_timestamp', 'messages']) {
      expect(isReadReasonCode(code), code).toBe(true);
    }

    for (const code of [
      'message_invalid_timestamp',
      'tool_call_orphan_result',
      'session_meta_event_creation_failed',
      'other_json_parse_error',
    ]) {
      expect(isReadReasonCode(code), code).toBe(false);
    }
  });

  it('records <kind>_<reason> only when the kind is read', () => {
    const diagnostics = createReadDiagnostics();

    recordKindSkippedRow(diagnostics, ALL, 'message', 'invalid_role');
    recordKindSkippedRow(diagnostics, USAGE, 'message', 'invalid_role');

    expect(reasons(diagnostics)).toEqual({
      skippedRows: 1,
      skippedRowReasons: [{ reason: 'message_invalid_role', count: 1 }],
    });
  });

  it('counts a malformed line as read does only when usage is read and the usage prefilter accepts it', () => {
    const diagnostics = createReadDiagnostics();

    recordMalformedLine(diagnostics, ALL, true);
    recordMalformedLine(diagnostics, ALL, false);
    recordMalformedLine(diagnostics, new Set(['message']), true);

    expect(reasons(diagnostics).skippedRowReasons).toEqual([
      { reason: 'json_parse_error', count: 1 },
      { reason: 'other_json_parse_error', count: 2 },
    ]);
  });
});

describe('createKindEvent', () => {
  it('builds an event only for a kind the read yields', () => {
    const diagnostics = createReadDiagnostics();
    let builds = 0;
    const create = () => {
      builds += 1;
      return { built: true };
    };

    expect(createKindEvent(diagnostics, ALL, 'tool_call', create)).toEqual({ built: true });
    expect(createKindEvent(diagnostics, USAGE, 'tool_call', create)).toBeUndefined();
    expect(builds).toBe(1);
  });

  it('counts a constructor that throws as <kind>_event_creation_failed', () => {
    const diagnostics = createReadDiagnostics();
    const failToCreate = (): object => {
      throw new Error('bad');
    };

    expect(createKindEvent(diagnostics, ALL, 'session_meta', failToCreate)).toBeUndefined();
    expect(reasons(diagnostics).skippedRowReasons).toEqual([
      { reason: 'session_meta_event_creation_failed', count: 1 },
    ]);
  });
});

describe('joinTextBlocks', () => {
  const TEXT = new Set(['text']);

  it('joins text blocks with a blank line, unaltered, leaving out other blocks', () => {
    expect(
      joinTextBlocks(
        [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: ' first\u0007 ' },
          { type: 'tool_use', name: 'Bash' },
          null,
          'loose',
          { type: 'text', text: '' },
          { type: 'text', text: 'last' },
        ],
        TEXT,
      ),
    ).toBe(' first\u0007 \n\n\n\nlast');
  });

  it('takes a string as the whole text', () => {
    expect(joinTextBlocks('  as logged  ', TEXT)).toBe('  as logged  ');
  });

  it('is undefined without a text block', () => {
    expect(joinTextBlocks([{ type: 'tool_result', content: 'x' }], TEXT)).toBeUndefined();
    expect(joinTextBlocks({ type: 'text', text: 'not a list' }, TEXT)).toBeUndefined();
    expect(joinTextBlocks([{ type: 'text', text: 3 }], TEXT)).toBeUndefined();
  });

  it('accepts the text block types a source names', () => {
    expect(
      joinTextBlocks(
        [
          { type: 'input_text', text: 'a' },
          { type: 'output_text', text: 'b' },
        ],
        new Set(['input_text', 'output_text']),
      ),
    ).toBe('a\n\nb');
  });
});

describe('ToolCallPairing', () => {
  it('pairs a result with its pending call once', () => {
    const pairing = new ToolCallPairing<string>(createReadDiagnostics(), ALL);

    expect(pairing.start('a', 'call a')).toBe(true);
    expect(pairing.finish('a')).toBe('call a');
    expect(pairing.takeUnanswered()).toEqual([]);
  });

  it('keeps the first call with an id, also after it was answered', () => {
    const pairing = new ToolCallPairing<string>(createReadDiagnostics(), ALL);

    pairing.start('a', 'first');
    expect(pairing.start('a', 'second')).toBe(false);
    expect(pairing.finish('a')).toBe('first');
    expect(pairing.start('a', 'third')).toBe(false);
    expect(pairing.takeUnanswered()).toEqual([]);
  });

  it('drops a result for an unknown id as an orphan, only when tool calls are read', () => {
    const diagnostics = createReadDiagnostics();
    const reading = new ToolCallPairing<string>(diagnostics, ALL);
    const notReading = new ToolCallPairing<string>(diagnostics, USAGE);

    expect(reading.finish('nobody')).toBeUndefined();
    expect(notReading.finish('nobody')).toBeUndefined();
    expect(reasons(diagnostics).skippedRowReasons).toEqual([
      { reason: 'tool_call_orphan_result', count: 1 },
    ]);
  });

  it('drops a repeated result for an answered call without counting it', () => {
    const diagnostics = createReadDiagnostics();
    const pairing = new ToolCallPairing<string>(diagnostics, ALL);

    pairing.start('a', 'call a');
    pairing.finish('a');

    expect(pairing.finish('a')).toBeUndefined();
    expect(diagnostics.skippedRows).toBe(0);
  });

  it('hands back unanswered calls at end of file in first-call order', () => {
    const pairing = new ToolCallPairing<string>(createReadDiagnostics(), ALL);

    pairing.start('c', 'call c');
    pairing.start('a', 'call a');
    pairing.start('b', 'call b');
    pairing.finish('a');

    expect(pairing.takeUnanswered()).toEqual(['call c', 'call b']);
    expect(pairing.takeUnanswered()).toEqual([]);
  });
});

describe('SessionMetaTracker', () => {
  it('emits a field when it first appears or changes, never an empty change', () => {
    const tracker = new SessionMetaTracker(false);

    expect(tracker.changes({ cwd: '/repo', gitBranch: 'main' })).toEqual({
      cwd: '/repo',
      gitBranch: 'main',
    });
    expect(tracker.changes({ cwd: '/repo', gitBranch: 'main' })).toBeUndefined();
    expect(tracker.changes({ cwd: ' /repo ', gitBranch: 'feature' })).toEqual({
      gitBranch: 'feature',
    });
    expect(tracker.changes({})).toBeUndefined();
    expect(tracker.changes({ cwd: '  ' })).toBeUndefined();
  });

  it('compares values as the constructor stores them', () => {
    const tracker = new SessionMetaTracker(false);

    tracker.changes({ model: 'GPT-5' });
    expect(tracker.changes({ model: 'gpt-5' })).toBeUndefined();
  });

  it('lets a later value override an earlier one, and the earlier one return', () => {
    const tracker = new SessionMetaTracker(false);

    tracker.changes({ gitBranch: 'a' });
    tracker.changes({ gitBranch: 'b' });
    expect(tracker.changes({ gitBranch: 'a' })).toEqual({ gitBranch: 'a' });
  });

  it('keeps titles only when text is read', () => {
    expect(new SessionMetaTracker(false).changes({ title: 'Secret' })).toBeUndefined();
    expect(new SessionMetaTracker(true).changes({ title: 'Secret' })).toEqual({
      title: 'Secret',
    });
  });

  it('ignores AI titles once a custom title is seen', () => {
    const tracker = new SessionMetaTracker(true);

    expect(tracker.changes({ title: 'AI one' }, { aiTitle: true })).toEqual({ title: 'AI one' });
    expect(tracker.changes({ title: 'Mine' })).toEqual({ title: 'Mine' });
    expect(tracker.changes({ title: 'AI two', cwd: '/r' }, { aiTitle: true })).toEqual({
      cwd: '/r',
    });
    expect(tracker.changes({ title: 'Mine again' })).toEqual({ title: 'Mine again' });
  });
});

describe('TimestampCarry', () => {
  it('gives a record without a timestamp the last valid one seen', () => {
    const carry = new TimestampCarry<string>();

    expect(carry.advance('t1')).toEqual([]);
    expect(carry.carry('title')).toBe('t1');
    carry.advance('t2');
    expect(carry.carry('title')).toBe('t2');
    expect(carry.takeUnreleased()).toEqual([]);
  });

  it('holds records until the next valid timestamp, then releases them in order', () => {
    const carry = new TimestampCarry<string>();

    expect(carry.carry('first')).toBeUndefined();
    expect(carry.carry('second')).toBeUndefined();
    expect(carry.advance('t1')).toEqual(['first', 'second']);
    expect(carry.advance('t2')).toEqual([]);
  });

  it('leaves held records unreleased when the file has no valid timestamp', () => {
    const carry = new TimestampCarry<string>();

    carry.carry('orphan');

    expect(carry.takeUnreleased()).toEqual(['orphan']);
    expect(carry.takeUnreleased()).toEqual([]);
  });
});
