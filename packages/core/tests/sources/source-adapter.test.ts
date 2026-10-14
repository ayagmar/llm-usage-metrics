import { describe, expect, expectTypeOf, it } from 'vitest';

import type { SourceId, UsageEvent } from '../../src/domain/usage-event.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  getRepeatingSourceIds,
  getSessionCopyingSourceIds,
  type SourceAdapter,
  type SourceCapabilities,
} from '../../src/sources/source-adapter.js';

describe('SourceAdapter contract', () => {
  it('supports strongly typed adapter implementations', async () => {
    class MockPiAdapter implements SourceAdapter {
      public readonly id = 'pi' as const;

      public discoverFiles(): Promise<string[]> {
        return Promise.resolve(['/tmp/session.jsonl']);
      }

      public parseFile(filePath: string): Promise<UsageEvent[]> {
        return Promise.resolve([
          createUsageEvent({
            source: 'pi',
            sessionId: filePath,
            timestamp: '2026-02-12T10:00:00Z',
            inputTokens: 10,
            outputTokens: 5,
          }),
        ]);
      }
    }

    const adapter = new MockPiAdapter();
    const events = await adapter.parseFile('/tmp/session.jsonl');

    expect(adapter.id).toBe('pi');
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('pi');
    expect(events[0]?.sessionId).toBe('/tmp/session.jsonl');

    expectTypeOf(adapter.id).toEqualTypeOf<'pi'>();
    expectTypeOf(events).toEqualTypeOf<UsageEvent[]>();
  });
});

describe('source capability helpers', () => {
  function createAdapter(id: SourceId, capabilities?: SourceCapabilities): SourceAdapter {
    return {
      id,
      capabilities,
      discoverFiles: () => Promise.resolve([]),
      parseFile: () => Promise.resolve([]),
    };
  }

  const adapters = [
    createAdapter('codex'),
    createAdapter('pi', { eventsRepeatAcrossFiles: true, eventsPrecedeFileMtime: true }),
    createAdapter('claude', { sessionsCopyEvents: true }),
    createAdapter('gemini', { eventsRepeatAcrossFiles: false, sessionsCopyEvents: false }),
  ];

  it('lists the sources whose files repeat events, in adapter order', () => {
    expect(getRepeatingSourceIds(adapters)).toEqual(['pi']);
    expect(getRepeatingSourceIds([])).toEqual([]);
  });

  it('lists the sources whose sessions copy events', () => {
    expect(getSessionCopyingSourceIds(adapters)).toEqual(new Set(['claude']));
    expect(getSessionCopyingSourceIds([createAdapter('codex')])).toEqual(new Set());
  });
});
