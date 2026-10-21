import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { readFrom } from '../helpers/fake-read.js';

/**
 * Synthetic usage across projects, for the M9 report goldens; read-only for their tests.
 *
 * - two sources, `claude` and `codex`, each with several repository roots;
 * - `/w/a/api/src`, a root under `/w/a/api` that a session started in, so it stays its own
 *   project;
 * - `/w/a/api` and `/w/b/api`, which share a basename;
 * - `/w/b/api/` with a trailing separator, the same project as `/w/b/api`;
 * - `C:\src\web`, a Windows-style root;
 * - events without a root (unattributed) in both sources;
 * - 2026-05-20/21, then 2026-06-15 across hours, where each source has a gap of more than
 *   5 h before its last event (claude 11:05 to 18:30, codex 14:30 to 21:00).
 */

type FixtureEventInput = {
  sessionId: string;
  timestamp: string;
  repoRoot?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

const SOURCE_MODELS = {
  claude: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  codex: { provider: 'openai', model: 'gpt-5' },
} as const;

type FixtureSource = keyof typeof SOURCE_MODELS;

const FIXTURE_INPUTS: Record<FixtureSource, readonly FixtureEventInput[]> = {
  claude: [
    {
      sessionId: 'claude-may',
      timestamp: '2026-05-20T15:00:00.000Z',
      repoRoot: '/w/a/api',
      inputTokens: 1_200,
      outputTokens: 300,
    },
    {
      sessionId: 'claude-api',
      timestamp: '2026-06-15T09:10:00.000Z',
      repoRoot: '/w/a/api',
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
    },
    {
      sessionId: 'claude-api-src',
      timestamp: '2026-06-15T09:40:00.000Z',
      repoRoot: '/w/a/api/src',
      inputTokens: 800,
      outputTokens: 200,
    },
    {
      sessionId: 'claude-other-api',
      timestamp: '2026-06-15T10:20:00.000Z',
      repoRoot: '/w/b/api',
      inputTokens: 1_500,
      outputTokens: 400,
    },
    {
      sessionId: 'claude-unattributed',
      timestamp: '2026-06-15T11:05:00.000Z',
      inputTokens: 600,
      outputTokens: 150,
    },
    {
      sessionId: 'claude-evening',
      timestamp: '2026-06-15T18:30:00.000Z',
      repoRoot: '/w/a/api',
      inputTokens: 3_000,
      outputTokens: 900,
    },
  ],
  codex: [
    {
      sessionId: 'codex-may',
      timestamp: '2026-05-21T16:00:00.000Z',
      repoRoot: 'C:\\src\\web',
      inputTokens: 1_000,
      outputTokens: 250,
    },
    {
      sessionId: 'codex-api',
      timestamp: '2026-06-15T08:00:00.000Z',
      repoRoot: '/w/b/api/',
      inputTokens: 4_000,
      outputTokens: 600,
      cacheReadTokens: 2_000,
    },
    {
      sessionId: 'codex-api',
      timestamp: '2026-06-15T12:15:00.000Z',
      repoRoot: '/w/b/api',
      inputTokens: 2_500,
      outputTokens: 700,
    },
    {
      sessionId: 'codex-web',
      timestamp: '2026-06-15T13:50:00.000Z',
      repoRoot: 'C:\\src\\web',
      inputTokens: 1_800,
      outputTokens: 300,
    },
    {
      sessionId: 'codex-unattributed',
      timestamp: '2026-06-15T14:30:00.000Z',
      inputTokens: 900,
      outputTokens: 100,
    },
    {
      sessionId: 'codex-tools',
      timestamp: '2026-06-15T21:00:00.000Z',
      repoRoot: '/w/c/tools',
      inputTokens: 700,
      outputTokens: 90,
    },
  ],
};

/** The one file each fixture source "discovers"; nothing is read from disk. */
export const PROJECT_FIXTURE_FILES: Record<FixtureSource, string> = {
  claude: '/project-fixture/claude/usage.jsonl',
  codex: '/project-fixture/codex/usage.jsonl',
};

function toEvents(source: FixtureSource): UsageEvent[] {
  return FIXTURE_INPUTS[source].map((input) =>
    createUsageEvent({ source, ...SOURCE_MODELS[source], ...input }),
  );
}

/** Every fixture event, claude first, each source in time order. */
export const PROJECT_FIXTURE_EVENTS: readonly UsageEvent[] = [
  ...toEvents('claude'),
  ...toEvents('codex'),
];

/** Adapters that yield the fixture events; pass them as the `createAdapters` dep. */
export function createProjectFixtureAdapters(): SourceAdapter[] {
  return (Object.keys(FIXTURE_INPUTS) as FixtureSource[]).map((source) => ({
    id: source,
    discoverFiles: async () => [PROJECT_FIXTURE_FILES[source]],
    read: readFrom(async () => PROJECT_FIXTURE_EVENTS.filter((event) => event.source === source)),
  }));
}
