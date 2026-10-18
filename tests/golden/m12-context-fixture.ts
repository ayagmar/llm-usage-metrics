import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';

/**
 * Synthetic prompts for the context report goldens and e2e tests; read-only for them.
 *
 * - `claude` and `gemini` record one request per event; `codex` does not, so it is listed
 *   as aggregated however large its records are;
 * - `ctx-claude-long` sends a 175k prompt to claude-sonnet-4-5 (limit 200k): near its limit,
 *   below the 200k tier boundary;
 * - `ctx-gemini-big` sends a 250k prompt to gemini-2.5-pro, which bills it at the tier rates;
 * - `ctx-claude-unknown` names a model LiteLLM does not list, so its limit is unknown;
 * - a gemini request on 2026-05-01 falls outside the default 7-day window (FIXED_NOW is
 *   2026-06-21).
 */

type FixtureInput = {
  source: 'claude' | 'gemini' | 'codex';
  model: string;
  sessionId: string;
  timestamp: string;
  repoRoot?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const FIXTURE_INPUTS: readonly FixtureInput[] = [
  {
    source: 'claude',
    model: 'claude-sonnet-4-5',
    sessionId: 'ctx-claude-long',
    timestamp: '2026-06-18T10:00:00.000Z',
    repoRoot: '/w/a/api',
    inputTokens: 20_000,
    cacheReadTokens: 150_000,
    cacheWriteTokens: 5_000,
    outputTokens: 2_000,
  },
  {
    source: 'claude',
    model: 'claude-sonnet-4-5',
    sessionId: 'ctx-claude-long',
    timestamp: '2026-06-18T10:05:00.000Z',
    repoRoot: '/w/a/api',
    inputTokens: 1_000,
    cacheReadTokens: 30_000,
    outputTokens: 500,
  },
  {
    source: 'claude',
    model: 'acme-internal-1',
    sessionId: 'ctx-claude-unknown',
    timestamp: '2026-06-19T08:00:00.000Z',
    inputTokens: 9_000,
    outputTokens: 100,
  },
  {
    source: 'gemini',
    model: 'gemini-2.5-pro',
    sessionId: 'ctx-gemini-big',
    timestamp: '2026-06-20T09:00:00.000Z',
    repoRoot: '/w/b/web',
    inputTokens: 230_000,
    cacheReadTokens: 20_000,
    outputTokens: 4_000,
  },
  {
    source: 'gemini',
    model: 'gemini-2.5-pro',
    sessionId: 'ctx-gemini-big',
    timestamp: '2026-06-20T09:30:00.000Z',
    repoRoot: '/w/b/web',
    inputTokens: 120_000,
    outputTokens: 1_000,
  },
  {
    source: 'gemini',
    model: 'gemini-2.5-pro',
    sessionId: 'ctx-gemini-old',
    timestamp: '2026-05-01T09:00:00.000Z',
    repoRoot: '/w/b/web',
    inputTokens: 900_000,
    outputTokens: 1_000,
  },
  {
    source: 'codex',
    model: 'gpt-5',
    sessionId: 'ctx-codex',
    timestamp: '2026-06-20T12:00:00.000Z',
    repoRoot: '/w/a/api',
    inputTokens: 300_000,
    outputTokens: 1_000,
  },
];

const PER_REQUEST_SOURCES = new Set(['claude', 'gemini']);

export const CONTEXT_FIXTURE_EVENTS: readonly UsageEvent[] = FIXTURE_INPUTS.map((input) =>
  createUsageEvent({
    ...input,
    provider: { claude: 'anthropic', gemini: 'google', codex: 'openai' }[input.source],
  }),
);

/** Adapters that yield the fixture events; pass them as the `createAdapters` dep. */
export function createContextFixtureAdapters(): SourceAdapter[] {
  return (['claude', 'gemini', 'codex'] as const).map((source) => ({
    id: source,
    ...(PER_REQUEST_SOURCES.has(source) ? { capabilities: { usagePerRequest: true } } : {}),
    discoverFiles: async () => [`/context-fixture/${source}/usage.jsonl`],
    read: readFrom(async () => CONTEXT_FIXTURE_EVENTS.filter((event) => event.source === source)),
  }));
}
