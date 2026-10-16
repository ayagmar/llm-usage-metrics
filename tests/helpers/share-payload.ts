import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import type { ShareCostMode, ShareReportData } from '../../src/share-report/types.js';
import { getPeriodKey } from '../../src/utils/time-buckets.js';
import { addUsd } from '../../src/utils/usd-math.js';
import { readFrom } from './fake-read.js';
import { mulberry32, pick, randomInt } from './seeded-random.js';

/** Roots that only their full paths tell apart, a basename collision, and no root. */
export const CORPUS_REPO_ROOTS = [
  'C:\\work\\app',
  'D:\\work\\app',
  '/w/a/api',
  '/w/b/api/',
  undefined,
] as const;

/** A model named by its file path, as local runtimes log it. */
export const CORPUS_PATH_MODEL = '/opt/models/local/llama-3-8b.gguf';

const MODELS: Record<string, readonly (string | undefined)[]> = {
  claude: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'unpriced-model-for-share-test', undefined],
  codex: ['gpt-5', 'gpt-5-mini', CORPUS_PATH_MODEL],
};

/**
 * Synthetic usage over 2026-03-01..2026-06-20: two sources, sessions spanning hours, logged
 * costs on some events (some of them $0), unpriced, path-like and missing models.
 */
export function generateShareCorpus(seed: number, sessionCount: number): UsageEvent[] {
  const random = mulberry32(seed);
  const events: UsageEvent[] = [];
  const startMs = Date.parse('2026-03-01T00:00:00.000Z');
  const spanMs = Date.parse('2026-06-20T00:00:00.000Z') - startMs;

  for (let session = 0; session < sessionCount; session += 1) {
    const source = pick(random, ['claude', 'codex']);
    const repoRoot = pick(random, CORPUS_REPO_ROOTS);
    let timeMs = startMs + randomInt(random, spanMs);

    for (let index = randomInt(random, 12) + 1; index > 0; index -= 1) {
      const logged = random() < 0.3;
      events.push(
        createUsageEvent({
          source,
          sessionId: `share-corpus-${String(session)}`,
          timestamp: new Date(timeMs).toISOString(),
          repoRoot,
          provider: source === 'claude' ? 'anthropic' : 'openai',
          model: pick(random, MODELS[source]),
          inputTokens: randomInt(random, 5_000),
          outputTokens: randomInt(random, 1_500),
          cacheReadTokens: randomInt(random, 20_000),
          cacheWriteTokens: randomInt(random, 2_000),
          ...(logged
            ? {
                costUsd: random() < 0.2 ? 0 : randomInt(random, 10_000) / 1e5,
                costMode: 'explicit',
              }
            : {}),
        }),
      );
      // Mostly short gaps, sometimes a long pause that ends a block or the active time.
      timeMs += random() < 0.15 ? randomInt(random, 8 * 3_600_000) : randomInt(random, 900_000);
    }
  }

  return events;
}

/** Fake `claude` and `codex` adapters yielding `events`. */
export function createCorpusAdapters(events: readonly UsageEvent[]): () => SourceAdapter[] {
  return () =>
    ['claude', 'codex'].map((source) => ({
      id: source,
      discoverFiles: async () => [`/share-corpus/${source}.jsonl`],
      read: readFrom(async () => events.filter((event) => event.source === source)),
    }));
}

export type RolledUpTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  events: number;
  costUsd: number | undefined;
  costIncomplete: boolean;
};

const TOKEN_COLUMNS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
] as const;

/** A report period key from a cube period key, as `getPeriodKey` buckets local dates. */
export function toReportPeriodKey(
  periodKey: string,
  granularity: 'daily' | 'weekly' | 'monthly',
): string {
  return getPeriodKey(`${periodKey.slice(0, 10)}T12:00:00.000Z`, granularity, 'UTC');
}

/**
 * Sums the cube by `groupOf(cell)` in one cost mode, the way the page rolls it up: tokens and
 * events added, costs with `addUsd`.
 */
export function rollUpCube(
  data: ShareReportData,
  mode: ShareCostMode,
  groupOf: (cell: number) => string,
): Map<string, RolledUpTotals> {
  const totals = new Map<string, RolledUpTotals>();
  const costs = data.cube.costs[mode];

  data.cube.period.forEach((_, cell) => {
    const key = groupOf(cell);
    let group = totals.get(key);

    if (!group) {
      group = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        events: 0,
        costUsd: undefined,
        costIncomplete: false,
      };
      totals.set(key, group);
    }

    for (const column of TOKEN_COLUMNS) {
      group[column] += data.cube[column][cell];
    }

    group.events += data.cube.eventCount[cell];
    const cost = costs?.costUsd[cell] ?? null;

    if (cost !== null) {
      group.costUsd = addUsd(group.costUsd ?? 0, cost);
    }

    if ((costs?.incompleteEvents[cell] ?? 0) > 0) {
      group.costIncomplete = true;
    }
  });

  return totals;
}
