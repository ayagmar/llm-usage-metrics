import { describe, expect, it } from 'vitest';

import { parseSelectedAdapters } from '../../src/cli/build-usage-data-parsing.js';
import { createUsageEvent } from '../../src/domain/usage-event.js';
import type { SourceAdapter } from '../../src/sources/source-adapter.js';

function createDelayedAdapter(
  id: string,
  filePath: string,
  stats: { current: number; max: number },
): SourceAdapter {
  return {
    id,
    discoverFiles: async () => [filePath],
    parseFile: async () => {
      stats.current += 1;
      stats.max = Math.max(stats.max, stats.current);

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      stats.current -= 1;

      return [
        createUsageEvent({
          source: id,
          sessionId: `${id}-session`,
          timestamp: '2026-02-01T00:00:00.000Z',
          inputTokens: 1,
          totalTokens: 1,
        }),
      ];
    },
  };
}

describe('build-usage-data-parsing', () => {
  it('enforces one global parse concurrency budget across adapters', async () => {
    const stats = { current: 0, max: 0 };

    const result = await parseSelectedAdapters(
      [
        createDelayedAdapter('pi', '/tmp/pi-delayed.jsonl', stats),
        createDelayedAdapter('codex', '/tmp/codex-delayed.jsonl', stats),
      ],
      1,
    );

    expect(result.sourceFailures).toEqual([]);
    expect(result.successfulParseResults).toHaveLength(2);
    expect(stats.max).toBe(1);
  });
});
