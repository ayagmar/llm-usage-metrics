import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SourceAdapter } from '@ayagmar/agent-sessions';

import { toProjectKey } from '../../src/aggregate/project-key.js';
import { buildProjectsData } from '../../src/cli/build-projects-data.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { attributeEventsToSessionRoots } from '../../src/session/aggregate-sessions.js';
import { readFrom } from '../helpers/fake-read.js';
import { freezeDate } from '../golden/golden-harness.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

function event(sessionId: string, timestamp: string, repoRoot?: string): UsageEvent {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: 10,
    ...(repoRoot === undefined ? {} : { repoRoot }),
  });
}

/** The project key each event is attributed to. */
function attributedRoots(...eventLists: UsageEvent[][]): (string | undefined)[][] {
  return attributeEventsToSessionRoots(eventLists).map((events) =>
    events.map((attributed) => toProjectKey(attributed.repoRoot)),
  );
}

describe('attributeEventsToSessionRoots', () => {
  it('keeps a session that cds into a subdirectory under the directory it started in', () => {
    expect(
      attributedRoots([
        event('s', '2026-06-01T10:00:00.000Z', '/w/app'),
        event('s', '2026-06-01T10:05:00.000Z', '/w/app/site'),
        event('s', '2026-06-01T10:10:00.000Z', '/w/app/site/src/'),
      ]),
    ).toEqual([['/w/app', '/w/app', '/w/app']]);
  });

  it('keeps a repository another session started in when a parent-folder session cds into it', () => {
    expect(
      attributedRoots(
        [
          event('parent', '2026-06-01T10:00:00.000Z', '/w'),
          event('parent', '2026-06-01T10:05:00.000Z', '/w/app/src'),
        ],
        [event('app', '2026-06-02T10:00:00.000Z', '/w/app')],
      ),
    ).toEqual([['/w', '/w/app'], ['/w/app']]);
  });

  it('gives a parent-folder session the repositories no session started in', () => {
    expect(
      attributedRoots([
        event('parent', '2026-06-01T10:00:00.000Z', '/w'),
        event('parent', '2026-06-01T10:05:00.000Z', '/w/never-launched'),
      ]),
    ).toEqual([['/w', '/w']]);
  });

  it('keeps usage logged outside the session root where it was logged', () => {
    expect(
      attributedRoots([
        event('s', '2026-06-01T10:00:00.000Z', '/w/app'),
        event('s', '2026-06-01T10:05:00.000Z', '/w/other'),
        event('s', '2026-06-01T10:06:00.000Z'),
      ]),
    ).toEqual([['/w/app', '/w/other', undefined]]);
  });

  it('takes the root from the earliest event, whatever order the events are read in', () => {
    const later = event('s', '2026-06-01T10:05:00.000Z', '/w/app/site');
    const earliest = event('s', '2026-06-01T10:00:00.000Z', '/w/app');

    expect(attributedRoots([later], [earliest])).toEqual([['/w/app'], ['/w/app']]);
  });

  it('walks Windows paths up to the session root', () => {
    expect(
      attributedRoots([
        event('s', '2026-06-01T10:00:00.000Z', 'C:\\w\\app'),
        event('s', '2026-06-01T10:05:00.000Z', 'C:\\w\\app\\site'),
      ]),
    ).toEqual([['C:\\w\\app', 'C:\\w\\app']]);
  });
});

describe('projects attributed to session roots', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  beforeAll(() => {
    freezeDate();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  // The session starts in /w/app on May 31 and moves into /w/app/site on June 1.
  const deps = {
    createAdapters: (): SourceAdapter[] => [
      {
        id: 'claude',
        discoverFiles: async () => ['/tmp/s.jsonl'],
        read: readFrom(async () => [
          event('s', '2026-05-31T23:00:00.000Z', '/w/app'),
          event('s', '2026-06-01T10:00:00.000Z', '/w/app/site'),
          event('t', '2026-06-01T11:00:00.000Z', '/w/other'),
        ]),
      },
    ],
  };
  const options = { timezone: 'UTC', pricingOffline: true } as const;
  const projectRoots = async (extra: Record<string, unknown>) =>
    (await buildProjectsData({ ...options, ...extra }, deps)).projects.map(
      (project) => project.repoRoot,
    );

  it('attributes a drifted event to its session root even when the window starts after it', async () => {
    expect(await projectRoots({ since: '2026-06-01' })).toEqual(['/w/app', '/w/other']);
  });

  it('selects drifted usage with --repo on the session root', async () => {
    const data = await buildProjectsData({ ...options, repo: '/w/app' }, deps);

    expect(data.projects.map((project) => [project.repoRoot, project.events])).toEqual([
      ['/w/app', 2],
    ]);
  });
});
