import { describe, expect, it, vi } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import {
  applyPricingToEvents,
  calculateEstimatedCostUsd,
  createPricingRunStats,
  DEFAULT_PRICING_POLICY,
  resolveRatesForEvent,
} from '../../src/pricing/cost-engine.js';
import type { ModelPricing, PricingSource } from '../../src/pricing/types.js';
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

    const pricedEvent = applyPricingToEvents([explicitEvent], source)[0];

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

    const pricedEvent = applyPricingToEvents([explicitZeroEvent], source)[0];

    expect(pricedEvent.costMode).toBe('estimated');
    expect(pricedEvent.costUsd).toBeCloseTo(0.0002, 10);
  });

  it('records in the run stats only the explicit $0 events it re-estimates', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
    });
    const baseEvent = {
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-16T10:00:00Z',
      inputTokens: 100,
      outputTokens: 50,
    };
    const events = [
      createUsageEvent({ ...baseEvent, model: 'gpt-5-codex', costUsd: 0, costMode: 'explicit' }),
      createUsageEvent({ ...baseEvent, model: 'unknown-model', costUsd: 0, costMode: 'explicit' }),
      createUsageEvent({ ...baseEvent, model: 'gpt-5-codex', costUsd: 1.5, costMode: 'explicit' }),
      createUsageEvent({ ...baseEvent, model: 'gpt-5-codex', costMode: 'estimated' }),
    ];
    const stats = createPricingRunStats();

    const pricedEvents = applyPricingToEvents(events, source, {
      policy: DEFAULT_PRICING_POLICY,
      stats,
    });

    expect(pricedEvents.map((event) => stats.reestimatedExplicitZero.has(event))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(stats.reestimatedExplicitZero.has(events[0])).toBe(false);
    expect(pricedEvents.some((event) => stats.priorityPriced.has(event))).toBe(false);
  });

  it('records the events it prices at a priority-fallback rate', () => {
    const source = new StaticPricingSource({
      pricingByModel: {
        'priority-only': { inputPer1MUsd: 1, outputPer1MUsd: 4, priorityFallback: true },
        'gpt-5-codex': { inputPer1MUsd: 1, outputPer1MUsd: 2 },
      },
    });
    const baseEvent = {
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-16T10:00:00Z',
      inputTokens: 100,
      outputTokens: 50,
    };
    const events = [
      createUsageEvent({ ...baseEvent, model: 'priority-only', costMode: 'estimated' }),
      createUsageEvent({ ...baseEvent, model: 'priority-only', costUsd: 0, costMode: 'explicit' }),
      createUsageEvent({ ...baseEvent, model: 'priority-only', costUsd: 2, costMode: 'explicit' }),
      createUsageEvent({ ...baseEvent, model: 'gpt-5-codex', costMode: 'estimated' }),
    ];
    const stats = createPricingRunStats();

    const pricedEvents = applyPricingToEvents(events, source, {
      policy: DEFAULT_PRICING_POLICY,
      stats,
    });

    // A logged non-zero cost is kept, so no priority rate priced it.
    expect(pricedEvents.map((event) => stats.priorityPriced.has(event))).toEqual([
      true,
      true,
      false,
      false,
    ]);
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

    const pricedEvent = applyPricingToEvents([event], source)[0];

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

    const [pricedEvent] = applyPricingToEvents(
      [
        createUsageEvent({
          source: 'codex',
          sessionId: 'alias-single-event',
          timestamp: '2026-02-16T10:00:00Z',
          model: 'gpt-5.3-codex',
          inputTokens: 100,
          outputTokens: 50,
          costMode: 'estimated',
        }),
      ],
      pricingSource,
    );

    expect(resolveModelAlias).toHaveBeenCalledWith('gpt-5.3-codex');
    expect(getPricing).toHaveBeenCalledTimes(1);
    expect(getPricing).toHaveBeenCalledWith('gpt-5-codex');
    expect(getPricing).not.toHaveBeenCalledWith('gpt-5.3-codex');
    expect(pricedEvent.costUsd).toBeCloseTo(0.0002, 10);
  });

  it('bills the reasoning share of output at the reasoning rate when configured', () => {
    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-3',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5-codex',
      inputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 50,
      totalTokens: 100,
      costMode: 'estimated',
    });

    const estimated = calculateEstimatedCostUsd(event, {
      inputPer1MUsd: 0,
      outputPer1MUsd: 2,
      reasoningPer1MUsd: 3,
      reasoningBilling: 'separate',
    });

    // 50 non-reasoning output tokens at $2/M plus 50 reasoning tokens at $3/M.
    expect(estimated).toBeCloseTo(0.00025, 10);
  });

  it('bills one-hour cache writes at the one-hour rate and the rest at the cache-write rate', () => {
    const event = createUsageEvent({
      source: 'claude',
      sessionId: 'session-1h',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'claude-opus-5-5',
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 600_000,
      costMode: 'estimated',
    });
    const pricing = { inputPer1MUsd: 4, outputPer1MUsd: 20, cacheWritePer1MUsd: 5 };

    // 400k five-minute writes at $5/M plus 600k one-hour writes at $8/M.
    expect(calculateEstimatedCostUsd(event, { ...pricing, cacheWrite1hPer1MUsd: 8 })).toBeCloseTo(
      6.8,
      10,
    );
    // Without a published one-hour rate every write bills at the cache-write rate.
    expect(calculateEstimatedCostUsd(event, pricing)).toBeCloseTo(5, 10);
  });

  it('charges separately billed reasoning only once when its rate equals the output rate', () => {
    const event = createUsageEvent({
      source: 'gemini',
      sessionId: 'session-flash',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gemini-3-flash-preview',
      inputTokens: 9935,
      outputTokens: 312,
      reasoningTokens: 228,
      totalTokens: 10247,
      costMode: 'estimated',
    });

    const estimated = calculateEstimatedCostUsd(event, {
      inputPer1MUsd: 0.5,
      outputPer1MUsd: 3,
      reasoningPer1MUsd: 3,
      reasoningBilling: 'separate',
    });

    expect(estimated).toBeCloseTo(0.0059035, 10);
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

  describe('long-context tiers', () => {
    const tieredPricing: ModelPricing = {
      inputPer1MUsd: 1,
      outputPer1MUsd: 5,
      cacheReadPer1MUsd: 0.1,
      cacheWritePer1MUsd: 1.25,
      cacheWrite1hPer1MUsd: 2,
      tiers: [
        { aboveTokens: 272_000, inputPer1MUsd: 4, outputPer1MUsd: 20 },
        {
          aboveTokens: 100_000,
          inputPer1MUsd: 2,
          outputPer1MUsd: 10,
          cacheReadPer1MUsd: 0.2,
          cacheWritePer1MUsd: 2.5,
          cacheWrite1hPer1MUsd: 4,
        },
      ],
    };

    function promptOf(tokens: { input?: number; cacheRead?: number; cacheWrite?: number }) {
      return createUsageEvent({
        source: 'claude',
        sessionId: 'session-1',
        timestamp: '2026-02-16T10:00:00Z',
        model: 'tiered-model',
        inputTokens: tokens.input ?? 0,
        cacheReadTokens: tokens.cacheRead ?? 0,
        cacheWriteTokens: tokens.cacheWrite ?? 0,
        outputTokens: 1_000,
        costMode: 'estimated',
      });
    }

    it('applies a tier only to a prompt strictly above its threshold', () => {
      expect(resolveRatesForEvent(promptOf({ input: 100_000 }), tieredPricing, true)).toBe(
        tieredPricing,
      );
      expect(
        resolveRatesForEvent(promptOf({ input: 100_001 }), tieredPricing, true).inputPer1MUsd,
      ).toBe(2);
    });

    it('counts cache reads and cache writes toward the prompt', () => {
      const event = promptOf({ input: 1_000, cacheRead: 90_000, cacheWrite: 10_000 });

      expect(resolveRatesForEvent(event, tieredPricing, true).inputPer1MUsd).toBe(2);
    });

    it('uses the highest crossed tier and the base rate for a bucket the tier lacks', () => {
      const rates = resolveRatesForEvent(promptOf({ input: 300_000 }), tieredPricing, true);

      expect(rates).toMatchObject({
        inputPer1MUsd: 4,
        outputPer1MUsd: 20,
        cacheReadPer1MUsd: 0.1,
        cacheWritePer1MUsd: 1.25,
        cacheWrite1hPer1MUsd: 2,
      });
    });

    it('keeps base rates for events that may sum several requests', () => {
      expect(resolveRatesForEvent(promptOf({ input: 300_000 }), tieredPricing, false)).toBe(
        tieredPricing,
      );
    });

    it('reuses one rate object per model and tier', () => {
      const first = resolveRatesForEvent(promptOf({ input: 150_000 }), tieredPricing, true);
      const second = resolveRatesForEvent(promptOf({ input: 160_000 }), tieredPricing, true);

      expect(second).toBe(first);
    });

    it('prices per-request sources at tier rates and other sources flat', () => {
      const source = new StaticPricingSource({ pricingByModel: { 'tiered-model': tieredPricing } });
      const claudeEvent = promptOf({ input: 50_000, cacheRead: 100_000, cacheWrite: 10_000 });
      const droidEvent = { ...claudeEvent, source: 'droid' };

      const [claudePriced, droidPriced] = applyPricingToEvents([claudeEvent, droidEvent], source, {
        policy: { costMode: 'both', perRequestSourceIds: new Set(['claude']) },
        stats: createPricingRunStats(),
      });

      // 160k prompt > 100k: 50k*$2 + 100k*$0.20 + 10k*$2.50 + 1k*$10, per 1M.
      expect(claudePriced.costUsd).toBeCloseTo(0.1 + 0.02 + 0.025 + 0.01, 10);
      // Flat: 50k*$1 + 100k*$0.10 + 10k*$1.25 + 1k*$5, per 1M.
      expect(droidPriced.costUsd).toBeCloseTo(0.05 + 0.01 + 0.0125 + 0.005, 10);
    });

    it('bills one-hour cache writes at the tier one-hour rate', () => {
      const source = new StaticPricingSource({ pricingByModel: { 'tiered-model': tieredPricing } });
      const event = createUsageEvent({
        source: 'claude',
        sessionId: 'session-1',
        timestamp: '2026-02-16T10:00:00Z',
        model: 'tiered-model',
        inputTokens: 100_000,
        cacheWriteTokens: 10_000,
        cacheWrite1hTokens: 4_000,
        outputTokens: 0,
        costMode: 'estimated',
      });

      const [priced] = applyPricingToEvents([event], source, {
        policy: { costMode: 'both', perRequestSourceIds: new Set(['claude']) },
        stats: createPricingRunStats(),
      });

      // 100k*$2 + 6k*$2.50 + 4k*$4, per 1M.
      expect(priced.costUsd).toBeCloseTo(0.2 + 0.015 + 0.016, 10);
    });
  });
});
