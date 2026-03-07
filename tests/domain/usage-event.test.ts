import { describe, expect, it } from 'vitest';

import {
  createUsageEvent,
  hasBillableTokenBuckets,
  isPriceableEvent,
} from '../../src/domain/usage-event.js';

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
      costMode: 'explicit',
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

  it('throws when explicit costMode has no cost', () => {
    expect(() =>
      createUsageEvent({
        source: 'pi',
        sessionId: 'session-3',
        timestamp: '2026-02-12T10:00:00Z',
        costMode: 'explicit',
      }),
    ).toThrow('requires costUsd');
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
