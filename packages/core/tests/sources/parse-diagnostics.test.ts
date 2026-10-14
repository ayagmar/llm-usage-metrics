import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { incrementSkippedReason, toParseDiagnostics } from '../../src/sources/parse-diagnostics.js';

describe('parse diagnostics', () => {
  it('counts each skipped reason and lists the reasons in code-point order', () => {
    const reasons = new Map<string, number>();

    for (const reason of ['missing_usage', 'Invalid_json', 'missing_usage', 'bad_timestamp']) {
      incrementSkippedReason(reasons, reason);
    }

    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session',
      timestamp: '2026-02-14T10:00:00.000Z',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(toParseDiagnostics([event], 4, reasons)).toEqual({
      events: [event],
      skippedRows: 4,
      skippedRowReasons: [
        { reason: 'Invalid_json', count: 1 },
        { reason: 'bad_timestamp', count: 1 },
        { reason: 'missing_usage', count: 2 },
      ],
    });
  });

  it('reports no reasons when nothing was skipped', () => {
    expect(toParseDiagnostics([], 0, new Map())).toEqual({
      events: [],
      skippedRows: 0,
      skippedRowReasons: [],
    });
  });
});
