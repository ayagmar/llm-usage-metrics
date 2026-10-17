import { describe, expect, it } from 'vitest';

import { aggregateContextPressure } from '../../src/context/context-pressure.js';
import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import type { ModelPricing } from '../../src/pricing/types.js';

// Base and above-200k rates per 1M tokens, so the tier extra is easy to work out by hand.
const TIERED_PRICING: ModelPricing = {
  inputPer1MUsd: 3,
  outputPer1MUsd: 15,
  cacheReadPer1MUsd: 0.3,
  cacheWritePer1MUsd: 3.75,
  tiers: [
    {
      aboveTokens: 200_000,
      inputPer1MUsd: 6,
      outputPer1MUsd: 22.5,
      cacheReadPer1MUsd: 0.6,
      cacheWritePer1MUsd: 7.5,
    },
  ],
};

function event(input: Partial<UsageEventInput> & { inputTokens: number }) {
  return createUsageEvent({
    source: 'claude',
    sessionId: 'session-a',
    timestamp: '2026-06-18T10:00:00.000Z',
    model: 'tiered-model',
    outputTokens: 0,
    ...input,
  });
}

const options = {
  perRequestSourceIds: new Set(['claude']),
  lookupPricing: () => TIERED_PRICING,
  getContextLimit: (model: string) => (model === 'tiered-model' ? 250_000 : undefined),
};

describe('aggregateContextPressure', () => {
  it('adds what the tier rates cost over the base rates, for prompts above the tier only', () => {
    const report = aggregateContextPressure(
      [
        // Prompt 210k: base 0.15×3 + 0.06×0.3 + 0.002×15 = 0.498;
        // tier 0.15×6 + 0.06×0.6 + 0.002×22.5 = 0.981; extra 0.483.
        event({ inputTokens: 150_000, cacheReadTokens: 60_000, outputTokens: 2_000 }),
        // Prompt exactly 200k: not above the tier, so it adds nothing.
        event({ inputTokens: 190_000, cacheWriteTokens: 10_000, outputTokens: 1_000 }),
      ],
      options,
    );

    expect(report.models).toEqual([
      {
        model: 'tiered-model',
        contextLimit: 250_000,
        requests: 2,
        peakPromptTokens: 210_000,
        longContextRequests: 1,
        longContextExtraUsd: 0.483,
        // 80% of 250k is 200k, which the second prompt reaches but does not pass.
        nearLimitRequests: 1,
      },
    ]);
  });

  it('counts cache writes in the prompt that crosses the tier', () => {
    // Prompt 201k: extra 0.1×(6−3) + 0.101×(7.5−3.75) = 0.3 + 0.37875.
    const report = aggregateContextPressure(
      [event({ inputTokens: 100_000, cacheWriteTokens: 101_000 })],
      options,
    );

    expect(report.models[0]?.longContextExtraUsd).toBeCloseTo(0.67875, 12);
  });

  it('leaves the extra and the near-limit count unknown without pricing or a limit', () => {
    const report = aggregateContextPressure([event({ inputTokens: 1_000, model: 'other' })], {
      ...options,
      lookupPricing: () => undefined,
    });

    expect(report.models).toEqual([
      {
        model: 'other',
        requests: 1,
        peakPromptTokens: 1_000,
        longContextRequests: 0,
        longContextExtraIncomplete: true,
      },
    ]);
  });

  it('lists sources without per-request usage instead of giving them a peak', () => {
    const report = aggregateContextPressure(
      [
        event({ inputTokens: 500_000, source: 'codex' }),
        event({ inputTokens: 1_000, source: 'codex', sessionId: 'session-b' }),
      ],
      options,
    );

    expect(report).toEqual({
      models: [],
      sessions: [],
      aggregatedSources: [{ source: 'codex', records: 2 }],
    });
  });

  it('orders sessions by peak prompt and names each model once', () => {
    const report = aggregateContextPressure(
      [
        event({ inputTokens: 1_000, sessionId: 'small' }),
        event({ inputTokens: 90_000, sessionId: 'large', repoRoot: '/w/a' }),
        event({ inputTokens: 80_000, sessionId: 'large', model: 'other' }),
        event({ inputTokens: 70_000, sessionId: 'large' }),
      ],
      options,
    );

    expect(
      report.sessions.map(({ sessionId, repoRoot, models, requests, peakPromptTokens }) => ({
        sessionId,
        repoRoot,
        models,
        requests,
        peakPromptTokens,
      })),
    ).toEqual([
      {
        sessionId: 'large',
        repoRoot: '/w/a',
        models: ['other', 'tiered-model'],
        requests: 3,
        peakPromptTokens: 90_000,
      },
      {
        sessionId: 'small',
        repoRoot: undefined,
        models: ['tiered-model'],
        requests: 1,
        peakPromptTokens: 1_000,
      },
    ]);
    // One of the session's three requests names a model without a known limit.
    expect(report.sessions[0]?.nearLimitRequests).toBe(0);
  });
});
