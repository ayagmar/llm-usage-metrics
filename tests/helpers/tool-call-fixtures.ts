import {
  createToolCallEvent,
  createUsageRecord,
  type SessionEvent,
  type SourceAdapter,
  type ToolCallStatus,
} from '@ayagmar/agent-sessions';

import { createUsageEvent } from '../../src/domain/usage-event.js';

/**
 * Sessions for the tools report, around 2026-06-21. claude's two sessions sit in
 * projects that share a last segment (`a/api`, `b/api`), the second copies a call of the
 * first (same tool call id), codex has a session before the default 7-day window, and pi's
 * session has tool calls but no usage, so no project.
 */
type FixtureSession = {
  source: string;
  sessionId: string;
  file: string;
  repoRoot?: string;
  usageAt?: string;
  calls: readonly [name: string, status: ToolCallStatus, at: string, id?: string][];
};

export const TOOL_FIXTURE_SESSIONS: readonly FixtureSession[] = [
  {
    source: 'claude',
    sessionId: 'claude-a',
    file: '/tools-fixture/claude/a.jsonl',
    repoRoot: '/w/a/api',
    usageAt: '2026-06-20T09:00:00.000Z',
    calls: [
      ['Bash', 'ok', '2026-06-20T09:01:00.000Z', 'toolu-1'],
      ['Bash', 'ok', '2026-06-20T09:02:00.000Z'],
      ['Bash', 'error', '2026-06-20T09:03:00.000Z'],
      ['Read', 'ok', '2026-06-20T09:04:00.000Z'],
      ['Read', 'ok', '2026-06-20T09:05:00.000Z'],
      ['Edit', 'unknown', '2026-06-20T09:06:00.000Z'],
    ],
  },
  {
    source: 'claude',
    sessionId: 'claude-b',
    file: '/tools-fixture/claude/b.jsonl',
    repoRoot: '/w/b/api',
    usageAt: '2026-06-21T08:00:00.000Z',
    calls: [
      ['Bash', 'ok', '2026-06-20T09:01:00.000Z', 'toolu-1'],
      ['Bash', 'ok', '2026-06-21T08:01:00.000Z'],
      ['Grep', 'error', '2026-06-21T08:02:00.000Z'],
    ],
  },
  {
    source: 'codex',
    sessionId: 'codex-c',
    file: '/tools-fixture/codex/c.jsonl',
    repoRoot: '/w/c/tools',
    usageAt: '2026-06-19T10:00:00.000Z',
    calls: [
      ['exec_command', 'ok', '2026-06-19T10:01:00.000Z'],
      ['exec_command', 'ok', '2026-06-19T10:02:00.000Z'],
      ['exec_command', 'error', '2026-06-19T10:03:00.000Z'],
      ['apply_patch', 'ok', '2026-06-19T10:04:00.000Z'],
      ['web_search', 'unknown', '2026-06-19T10:05:00.000Z'],
    ],
  },
  {
    source: 'codex',
    sessionId: 'codex-old',
    file: '/tools-fixture/codex/old.jsonl',
    repoRoot: '/w/c/tools',
    usageAt: '2026-06-01T10:00:00.000Z',
    calls: [
      ['exec_command', 'ok', '2026-06-01T10:01:00.000Z'],
      ['exec_command', 'ok', '2026-06-01T10:02:00.000Z'],
      ['exec_command', 'ok', '2026-06-01T10:03:00.000Z'],
    ],
  },
  {
    source: 'pi',
    sessionId: 'pi-d',
    file: '/tools-fixture/pi/d.jsonl',
    calls: [
      ['bash', 'ok', '2026-06-18T12:00:00.000Z'],
      ['read', 'error', '2026-06-18T12:01:00.000Z'],
    ],
  },
];

function toEvents(session: FixtureSession): SessionEvent[] {
  const usage =
    session.usageAt === undefined
      ? []
      : [
          createUsageRecord({
            source: session.source,
            sessionId: session.sessionId,
            timestamp: session.usageAt,
            repoRoot: session.repoRoot,
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            inputTokens: 1_000,
            outputTokens: 100,
          }),
        ];

  return [
    ...usage,
    ...session.calls.map(([name, status, at, id]) =>
      createToolCallEvent({
        source: session.source,
        sessionId: session.sessionId,
        timestamp: at,
        name,
        status,
        toolCallId: id,
      }),
    ),
  ];
}

export type ToolFixtureOptions = {
  /** Files whose live read throws; their usage still parses. */
  failingFiles?: ReadonlySet<string>;
  /** Called with each file a live read opens. */
  onLiveRead?: (filePath: string) => void;
};

/**
 * Fake claude, codex and pi adapters over `TOOL_FIXTURE_SESSIONS`, declaring tool calls, and
 * a usage-only gemini adapter whose file must never be read live.
 */
export function createToolFixtureAdapters(options: ToolFixtureOptions = {}): SourceAdapter[] {
  const toolAdapters = ['pi', 'codex', 'claude'].map((source): SourceAdapter => {
    const sessions = TOOL_FIXTURE_SESSIONS.filter((session) => session.source === source);
    const eventsOf = (filePath: string) =>
      sessions.filter((session) => session.file === filePath).flatMap(toEvents);

    return {
      id: source,
      capabilities: { kinds: ['usage', 'tool_call'] },
      discoverFiles: async () => sessions.map((session) => session.file),
      async *read(filePath) {
        for (const event of eventsOf(filePath)) {
          if (event.kind === 'usage') {
            yield createUsageEvent(event);
          }
        }
      },
      async *readEvents(filePath, readOptions) {
        options.onLiveRead?.(filePath);

        if (options.failingFiles?.has(filePath)) {
          throw new Error('unreadable');
        }

        yield* eventsOf(filePath).filter(
          (event) => readOptions?.kinds?.includes(event.kind) ?? true,
        );
      },
    };
  });
  const gemini: SourceAdapter = {
    id: 'gemini',
    discoverFiles: async () => ['/tools-fixture/gemini/e.json'],
    async *read() {
      yield createUsageEvent({
        source: 'gemini',
        sessionId: 'gemini-e',
        timestamp: '2026-06-20T10:00:00.000Z',
        provider: 'google',
        model: 'gemini-2.5-pro',
        inputTokens: 10,
        outputTokens: 1,
      });
    },
  };

  return [...toolAdapters, gemini];
}
