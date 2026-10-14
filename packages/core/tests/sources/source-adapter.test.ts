import { describe, expect, expectTypeOf, it } from 'vitest';

import type { UsageEvent } from '../../src/domain/usage-event.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

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
