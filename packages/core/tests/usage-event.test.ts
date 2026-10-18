import { describe, expect, it } from 'vitest';

import {
  createUsageEvent,
  getEventSessionKey,
  hasBillableTokenBuckets,
  isPriceableEvent,
} from '../src/domain/usage-event.js';

describe('createUsageEvent', () => {
  it('normalizes counters and trusts declared total tokens when provided', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-12T10:00:00Z',
      inputTokens: 10,
      outputTokens: '25',
      reasoningTokens: 5.9,
      cacheReadTokens: -1,
      cacheWriteTokens: undefined,
      totalTokens: 20,
      costUsd: '0.15',
    });

    expect(event).toMatchObject({
      source: 'pi',
      sessionId: 'session-1',
      inputTokens: 10,
      outputTokens: 25,
      reasoningTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 20,
      costUsd: 0.15,
    });
  });

  it('falls back to component total when declared total is missing', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-component-total',
      timestamp: '2026-02-12T10:00:00Z',
      inputTokens: 10,
      outputTokens: 25,
      reasoningTokens: 5,
      cacheReadTokens: 2,
    });

    expect(event.totalTokens).toBe(42);
  });

  it('preserves an explicit zero total token value', () => {
    const event = createUsageEvent({
      source: 'droid',
      sessionId: 'session-zero-total',
      timestamp: '2026-02-12T10:00:00Z',
      reasoningTokens: 5,
      totalTokens: 0,
    });

    expect(event.totalTokens).toBe(0);
    expect(event.reasoningTokens).toBe(5);
  });

  it('rejects a token count above 1e12 as corrupt instead of adding it to totals', () => {
    const base = { source: 'pi', sessionId: 'session-cap', timestamp: '2026-02-12T10:00:00Z' };

    expect(createUsageEvent({ ...base, inputTokens: 1e12 }).inputTokens).toBe(1e12);
    expect(() => createUsageEvent({ ...base, inputTokens: 1e30 })).toThrow(
      'UsageEvent inputTokens exceeds 1000000000000',
    );
    expect(() => createUsageEvent({ ...base, cacheReadTokens: '2e12' })).toThrow('cacheReadTokens');
    expect(() => createUsageEvent({ ...base, totalTokens: 1e13 })).toThrow('totalTokens');
  });

  it('throws on empty source or session id', () => {
    expect(() =>
      createUsageEvent({
        source: ' ',
        sessionId: 'session-4',
        timestamp: '2026-02-12T10:00:00Z',
      }),
    ).toThrow('source');

    expect(() =>
      createUsageEvent({
        source: 'pi',
        sessionId: ' ',
        timestamp: '2026-02-12T10:00:00Z',
      }),
    ).toThrow('sessionId');
  });

  it('throws when source is not a string', () => {
    expect(() =>
      createUsageEvent({
        source: 123 as unknown as string,
        sessionId: 'session-non-string-source',
        timestamp: '2026-02-12T10:00:00Z',
      }),
    ).toThrow('source');
  });

  it('strips control characters from session-derived strings', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'abc\u0007def',
      timestamp: '2026-02-12T10:00:00Z',
      repoRoot: '/x\u009B/y',
      model: 'GPT\u001B[2J-4',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(event.sessionId).toBe('abcdef');
    expect(event.repoRoot).toBe('/x/y');
    expect(event.model).toBe('gpt[2j-4');
  });

  it('throws when session id contains only control characters', () => {
    expect(() =>
      createUsageEvent({
        source: 'pi',
        sessionId: '\u001B\u0007',
        timestamp: '2026-02-12T10:00:00Z',
      }),
    ).toThrow('sessionId');
  });

  it('normalizes model identifiers to lowercase', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-model-normalization',
      timestamp: '2026-02-12T10:00:00Z',
      model: ' GPT-4.1 ',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(event.model).toBe('gpt-4.1');
  });

  it('strips control characters when normalizing model keys', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-model-control-chars',
      timestamp: '2026-02-12T10:00:00Z',
      model: ' GPT\u001B[2J-4.1 ',
      inputTokens: 1,
      outputTokens: 1,
    });
    const controlOnlyModelEvent = createUsageEvent({
      source: 'pi',
      sessionId: 'session-model-control-only',
      timestamp: '2026-02-12T10:00:00Z',
      model: '\u0007',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(event.model).toBe('gpt[2j-4.1');
    expect(controlOnlyModelEvent.model).toBeUndefined();
  });

  it('truncates model keys longer than 256 characters', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-model-truncation',
      timestamp: '2026-02-12T10:00:00Z',
      model: 'm'.repeat(300),
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(event.model).toBe('m'.repeat(256));
  });

  it('normalizes provider identifiers to billing entities', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-provider-normalization',
      timestamp: '2026-02-12T10:00:00Z',
      provider: ' OpenAI-Codex ',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(event.provider).toBe('openai');
  });

  it('keeps repo root metadata when provided', () => {
    const event = createUsageEvent({
      source: 'pi',
      sessionId: 'session-repo-root',
      timestamp: '2026-02-12T10:00:00Z',
      repoRoot: ' /workspace/repo ',
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(event.repoRoot).toBe('/workspace/repo');
  });

  it('treats total-only usage as non-priceable until billable buckets exist', () => {
    const totalOnlyEvent = createUsageEvent({
      source: 'pi',
      sessionId: 'session-total-only',
      timestamp: '2026-02-12T10:00:00Z',
      model: 'gpt-5.2',
      totalTokens: 42,
    });

    const billableEvent = createUsageEvent({
      source: 'pi',
      sessionId: 'session-billable',
      timestamp: '2026-02-12T10:00:00Z',
      model: 'gpt-5.2',
      inputTokens: 21,
      totalTokens: 42,
    });

    expect(hasBillableTokenBuckets(totalOnlyEvent)).toBe(false);
    expect(isPriceableEvent(totalOnlyEvent)).toBe(false);
    expect(hasBillableTokenBuckets(billableEvent)).toBe(true);
    expect(isPriceableEvent(billableEvent)).toBe(true);
  });
});

describe('getEventSessionKey', () => {
  it('keeps equal session ids from different sources apart', () => {
    const piKey = getEventSessionKey({ source: 'pi', sessionId: 'session-1' });

    expect(getEventSessionKey({ source: 'pi', sessionId: 'session-1' })).toBe(piKey);
    expect(getEventSessionKey({ source: 'codex', sessionId: 'session-1' })).not.toBe(piKey);
  });

  it('keeps the source and session id apart when an id contains a colon', () => {
    expect(getEventSessionKey({ source: 'pi', sessionId: 'a:b' })).not.toBe(
      getEventSessionKey({ source: 'pi:a', sessionId: 'b' }),
    );
  });

  it('cannot be forged through createUsageEvent by ids that contain the NUL separator', () => {
    const timestamp = '2026-02-12T10:00:00Z';
    const nulInSessionId = createUsageEvent({ source: 'pi', sessionId: 'a\0b', timestamp });
    const nulInSource = createUsageEvent({ source: 'pi\0a', sessionId: 'b', timestamp });

    expect(getEventSessionKey(nulInSessionId)).toBe('pi\0ab');
    expect(getEventSessionKey(nulInSource)).toBe('pia\0b');
  });
});
