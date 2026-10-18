import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectFile } from '@ayagmar/agent-sessions';
import { DroidSourceAdapter } from '@ayagmar/agent-sessions/sources/droid';

// Freezes v0.11.0 parsing of a Droid session that reports thinking tokens (KI-6).
const fixtureDir = path.resolve('tests/fixtures/golden/droid/thinking');

describe('Droid session with thinking tokens', () => {
  it('keeps thinking tokens beside output tokens and out of the total', async () => {
    const adapter = new DroidSourceAdapter({ dir: fixtureDir });

    const result = await collectFile(
      adapter,
      path.join(fixtureDir, 'session-thinking.settings.json'),
    );

    expect(result.skippedRows).toBe(0);
    expect(result.events).toHaveLength(1);
    // KI-6: unverified whether Factory reports thinking inside or beside outputTokens.
    // Today reasoningTokens (400) exceeds outputTokens (100) and the total is
    // input + output only.
    expect(result.events[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 400,
      totalTokens: 1100,
    });
  });
});
