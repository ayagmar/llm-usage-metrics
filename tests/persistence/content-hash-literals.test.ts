import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { computeEventContentHash } from '../../src/persistence/event-store-codec.js';

// Stored events carry these hashes, and history and machine merges match on them, so a
// change to the hash input or its encoding would stop stored events matching their
// reparsed copies. The literals were computed before the hash moved into core.
describe('computeEventContentHash literals', () => {
  it('hashes an unpriced estimated event', () => {
    const event = createUsageEvent({
      source: 'codex',
      sessionId: 'session-estimated',
      timestamp: '2026-02-12T10:00:00.000Z',
      provider: 'openai',
      model: 'gpt-5.2',
      repoRoot: '/repos/project',
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 15,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      totalTokens: 465,
    });

    expect(event.costMode).toBe('estimated');
    expect(computeEventContentHash(event)).toBe('35605898314e1698');
  });

  it('hashes an explicit-cost event', () => {
    const event = createUsageEvent({
      source: 'claude',
      sessionId: 'session-explicit',
      timestamp: '2026-02-12T11:30:00.000Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      cacheWrite1hTokens: 30,
      costUsd: 0.0125,
    });

    expect(event.costMode).toBe('explicit');
    expect(computeEventContentHash(event)).toBe('23ac394ec7b9a54a');
  });
});
