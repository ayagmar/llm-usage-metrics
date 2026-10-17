import { describe, expect, it } from 'vitest';

import * as activeTime from '../../src/domain/active-time.js';
import * as normalization from '../../src/domain/normalization.js';
import * as providerNormalization from '../../src/domain/provider-normalization.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';

describe('createUsageEvent cost mode', () => {
  it('defaults to estimated mode when cost is missing', () => {
    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-2',
      timestamp: '2026-02-12T10:00:00Z',
      inputTokens: 1,
      outputTokens: 2,
    });

    expect(event.costMode).toBe('estimated');
    expect(event.costUsd).toBeUndefined();
  });

  it('defaults to explicit mode when a cost is given', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-12T10:00:00Z',
      costUsd: '0.15',
    });

    expect(event.costMode).toBe('explicit');
    expect(event.costUsd).toBe(0.15);
  });

  it('keeps a stored estimated mode on a priced event', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-priced',
      timestamp: '2026-02-12T10:00:00Z',
      costUsd: 0.5,
      costMode: 'estimated',
    });

    expect(event.costMode).toBe('estimated');
  });

  it('throws when explicit costMode has no cost', () => {
    expect(() =>
      createUsageEvent({
        source: 'pi',
        sessionId: 'session-3',
        timestamp: '2026-02-12T10:00:00Z',
        costMode: 'explicit',
      }),
    ).toThrow('UsageEvent with costMode "explicit" requires costUsd');
  });

  it('reports the source first, then the cost mode, then the session id and timestamp', () => {
    expect(() =>
      createUsageEvent({
        source: ' ',
        sessionId: ' ',
        timestamp: 'not a date',
        costMode: 'explicit',
      }),
    ).toThrow('UsageEvent source must be a non-empty string');

    expect(() =>
      createUsageEvent({
        source: 'pi',
        sessionId: ' ',
        timestamp: 'not a date',
        costMode: 'explicit',
      }),
    ).toThrow('requires costUsd');

    expect(() =>
      createUsageEvent({
        source: 'pi',
        sessionId: ' ',
        timestamp: 'not a date',
      }),
    ).toThrow('sessionId');
  });

  // Serialized events feed machine-export revisions and the event goldens.
  it('serializes costMode right after costUsd', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-order',
      timestamp: '2026-02-12T10:00:00Z',
      costUsd: 0.25,
    });

    expect(Object.keys(event).slice(-2)).toEqual(['costUsd', 'costMode']);
  });
});

// The domain shims re-export the core package, whose event factory sets no cost mode.
describe('domain shims', () => {
  it.each([
    ['active-time', activeTime.createUsageEvent],
    ['normalization', normalization.createUsageEvent],
    ['provider-normalization', providerNormalization.createUsageEvent],
  ])('%s exports the event factory that sets a cost mode', (_shim, create) => {
    const event = create({ source: 'codex', sessionId: 's', timestamp: '2026-02-12T10:00:00Z' });

    expect(event.costMode).toBe('estimated');
  });
});
