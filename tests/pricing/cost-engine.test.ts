import { describe, expect, it, vi } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  applyPricingToEvent,
  applyPricingToEvents,
  calculateEstimatedCostUsd,
} from '../../src/pricing/cost-engine.js';
import type { PricingSource } from '../../src/pricing/types.js';
import { StaticPricingSource } from '../helpers/static-pricing-source.js';

describe('cost engine', () => {
  it('keeps non-zero explicit costs unchanged', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
    });

    const explicitEvent = createUsageEvent({
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 1.23,
      costMode: 'explicit',
    });

    const pricedEvent = applyPricingToEvent(explicitEvent, source);

    expect(pricedEvent.costMode).toBe('explicit');
    expect(pricedEvent.costUsd).toBe(1.23);
  });

  it('re-prices explicit zero cost when model pricing is available', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
    });

    const explicitZeroEvent = createUsageEvent({
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
      costMode: 'explicit',
    });

    const pricedEvent = applyPricingToEvent(explicitZeroEvent, source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeCloseTo(0.0002, 10);
  });

  it('estimates cost using alias mapping without double charging reasoning by default', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
          cacheReadPer1MUsd: 0.5,
          cacheWritePer1MUsd: 1,
        },
      },
      modelAliases: {
        'gpt-5.3-codex': 'gpt-5-codex',
      },
    });

    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-2',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5.3-codex',
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 300,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      costMode: 'estimated',
    });

    const pricedEvent = applyPricingToEvent(event, source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeCloseTo(0.00215, 10);
  });

  it('resolves model aliases before single-event pricing lookups', () => {
    const resolveModelAlias = vi.fn((model: string) =>
      model === 'gpt-5.3-codex' ? 'gpt-5-codex' : model,
    );
    const getPricing = vi.fn((model: string) =>
      model === 'gpt-5-codex'
        ? {
            inputPer1MUsd: 1,
            outputPer1MUsd: 2,
          }
        : undefined,
    );
    const pricingSource: PricingSource = {
      resolveModelAlias,
      getPricing,
    };

    const pricedEvent = applyPricingToEvent(
      createUsageEvent({
        source: 'codex',
        sessionId: 'alias-single-event',
        timestamp: '2026-02-16T10:00:00Z',
        model: 'gpt-5.3-codex',
        inputTokens: 100,
        outputTokens: 50,
        costMode: 'estimated',
      }),
      pricingSource,
    );

    expect(resolveModelAlias).toHaveBeenCalledWith('gpt-5.3-codex');
    expect(getPricing).toHaveBeenCalledWith('gpt-5-codex');
    expect(pricedEvent.costUsd).toBeCloseTo(0.0002, 10);
  });

  it('can charge reasoning tokens separately when configured', () => {
    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-3',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      inputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 50,
      costMode: 'estimated',
    });

    const estimated = calculateEstimatedCostUsd(event, {
      inputPer1MUsd: 0,
      outputPer1MUsd: 2,
      reasoningPer1MUsd: 3,
      reasoningBilling: 'separate',
    });

    expect(estimated).toBeCloseTo(0.00035, 10);
  });

  it('keeps estimated mode with undefined cost when no pricing exists', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-4.1': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-4',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'unknown-model',
      inputTokens: 10,
      outputTokens: 20,
      costMode: 'estimated',
    });

    const [pricedEvent] = applyPricingToEvents([event], source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeUndefined();
  });

  it('does not synthesize estimated zero cost from total-only usage', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5.2': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const event = createUsageEvent({
      source: 'opencode',
      sessionId: 'session-total-only',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5.2',
      totalTokens: 42,
      costMode: 'estimated',
    });

    const [pricedEvent] = applyPricingToEvents([event], source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeUndefined();
  });

  it('does not synthesize estimated zero cost from reasoning-only usage when reasoning is included in output', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5.2': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const event = createUsageEvent({
      source: 'opencode',
      sessionId: 'session-reasoning-only',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5.2',
      reasoningTokens: 42,
      totalTokens: 42,
      costMode: 'estimated',
    });

    const [pricedEvent] = applyPricingToEvents([event], source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeUndefined();
  });

  it('can estimate reasoning-only usage when reasoning is billed separately', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
          reasoningPer1MUsd: 3,
          reasoningBilling: 'separate',
        },
      },
    });

    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-reasoning-only-separate',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      reasoningTokens: 50,
      totalTokens: 50,
      costMode: 'estimated',
    });

    const [pricedEvent] = applyPricingToEvents([event], source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeCloseTo(0.00015, 10);
  });

  it('does not synthesize estimated zero cost when cache read pricing is missing', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-cache-read-only',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      cacheReadTokens: 100,
      totalTokens: 100,
      costMode: 'estimated',
    });

    const [pricedEvent] = applyPricingToEvents([event], source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeUndefined();
  });

  it('does not synthesize estimated zero cost when cache write pricing is missing', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        },
      },
    });

    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-cache-write-only',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      cacheWriteTokens: 50,
      totalTokens: 50,
      costMode: 'estimated',
    });

    const [pricedEvent] = applyPricingToEvents([event], source);

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeUndefined();
  });

  it('resolves pricing once per distinct model when pricing multiple events', () => {
    const getPricing = vi.fn((model: string) => {
      if (model === 'gpt-5-codex' || model === 'gpt-4.1') {
        return {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        };
      }

      return undefined;
    });

    const pricingSource: PricingSource = {
      resolveModelAlias: (model) => model,
      getPricing,
    };

    const events = [
      createUsageEvent({
        source: 'codex',
        sessionId: 'session-a',
        timestamp: '2026-02-16T10:00:00Z',
        model: 'gpt-5-codex',
        inputTokens: 100,
        outputTokens: 50,
        costMode: 'estimated',
      }),
      createUsageEvent({
        source: 'codex',
        sessionId: 'session-b',
        timestamp: '2026-02-16T10:01:00Z',
        model: 'gpt-5-codex',
        inputTokens: 200,
        outputTokens: 100,
        costMode: 'estimated',
      }),
      createUsageEvent({
        source: 'codex',
        sessionId: 'session-c',
        timestamp: '2026-02-16T10:02:00Z',
        model: 'gpt-4.1',
        inputTokens: 300,
        outputTokens: 150,
        costMode: 'estimated',
      }),
      createUsageEvent({
        source: 'codex',
        sessionId: 'session-d',
        timestamp: '2026-02-16T10:03:00Z',
        model: 'gpt-4.1',
        inputTokens: 400,
        outputTokens: 200,
        costMode: 'estimated',
      }),
    ];

    const pricedEvents = applyPricingToEvents(events, pricingSource);

    expect(pricedEvents).toHaveLength(4);
    expect(getPricing).toHaveBeenCalledTimes(2);
    expect(getPricing).toHaveBeenCalledWith('gpt-5-codex');
    expect(getPricing).toHaveBeenCalledWith('gpt-4.1');
  });

  it('reuses cached pricing across alias variants that resolve to one canonical model', () => {
    const resolveModelAlias = vi.fn((model: string) =>
      model.startsWith('gpt-5.3') ? 'gpt-5-codex' : model,
    );
    const getPricing = vi.fn((model: string) => {
      if (model === 'gpt-5-codex') {
        return {
          inputPer1MUsd: 1,
          outputPer1MUsd: 2,
        };
      }

      return undefined;
    });
    const pricingSource: PricingSource = {
      resolveModelAlias,
      getPricing,
    };

    const pricedEvents = applyPricingToEvents(
      [
        createUsageEvent({
          source: 'codex',
          sessionId: 'session-a',
          timestamp: '2026-02-16T10:00:00Z',
          model: 'gpt-5.3-codex',
          inputTokens: 100,
          outputTokens: 50,
          costMode: 'estimated',
        }),
        createUsageEvent({
          source: 'codex',
          sessionId: 'session-b',
          timestamp: '2026-02-16T10:01:00Z',
          model: 'gpt-5.3-codex-preview',
          inputTokens: 200,
          outputTokens: 100,
          costMode: 'estimated',
        }),
      ],
      pricingSource,
    );

    expect(pricedEvents).toHaveLength(2);
    expect(resolveModelAlias).toHaveBeenCalledTimes(2);
    expect(getPricing).toHaveBeenCalledTimes(1);
    expect(getPricing).toHaveBeenCalledWith('gpt-5-codex');
  });
});
