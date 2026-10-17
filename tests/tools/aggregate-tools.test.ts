import { createToolCallEvent, type ToolCallEvent } from '@ayagmar/agent-sessions';
import { describe, expect, it } from 'vitest';

import { aggregateTools } from '../../src/tools/aggregate-tools.js';

function call(
  name: string,
  status: ToolCallEvent['status'],
  options: { source?: string; sessionId?: string; toolCallId?: string } = {},
): ToolCallEvent {
  return createToolCallEvent({
    source: options.source ?? 'claude',
    sessionId: options.sessionId ?? 's1',
    timestamp: '2026-06-20T10:00:00.000Z',
    name,
    status,
    toolCallId: options.toolCallId,
  });
}

const sessionRepoRoots = new Map<string, string | undefined>([
  ['claude\0s1', '/w/api'],
  ['claude\0s2', '/w/web'],
  ['codex\0s3', '/w/api'],
  ['claude\0s4', undefined],
]);

describe('aggregateTools', () => {
  it('counts errors and unknown results, and rates errors over the calls with a result', () => {
    const { rows, totals } = aggregateTools(
      [call('Bash', 'ok'), call('Bash', 'error'), call('Bash', 'unknown'), call('Bash', 'ok')],
      { sessionRepoRoots },
    );

    expect(rows).toEqual([
      expect.objectContaining({ name: 'Bash', calls: 4, errors: 1, unknown: 1, errorRate: 1 / 3 }),
    ]);
    expect(totals).toMatchObject({ calls: 4, errors: 1, unknown: 1, tools: 1 });
  });

  it('has no error rate for a tool whose calls never got a result', () => {
    const { rows } = aggregateTools([call('Grep', 'unknown')], { sessionRepoRoots });

    expect(rows[0]).toMatchObject({ errors: 0, unknown: 1, errorRate: null });
  });

  it('counts each session once per tool, and the same session id of two sources twice', () => {
    const { rows, totals } = aggregateTools(
      [
        call('Read', 'ok', { sessionId: 's1' }),
        call('Read', 'ok', { sessionId: 's1' }),
        call('Read', 'ok', { sessionId: 's2' }),
        call('Read', 'ok', { source: 'codex', sessionId: 's1' }),
        call('Edit', 'ok', { sessionId: 's1' }),
      ],
      { sessionRepoRoots },
    );

    expect(rows.map((row) => [row.name, row.calls, row.sessions])).toEqual([
      ['Read', 4, 3],
      ['Edit', 1, 1],
    ]);
    expect(totals.sessions).toBe(3);
  });

  it('names the project with most calls, and a session without usage as unattributed', () => {
    const { rows } = aggregateTools(
      [
        call('Read', 'ok', { sessionId: 's2' }),
        call('Read', 'ok', { sessionId: 's1' }),
        call('Read', 'ok', { source: 'codex', sessionId: 's3' }),
        call('Bash', 'ok', { sessionId: 'no-usage' }),
        call('Bash', 'ok', { sessionId: 's4' }),
      ],
      { sessionRepoRoots },
    );

    expect(rows.map((row) => [row.name, row.topRepoRoot])).toEqual([
      ['Read', '/w/api'],
      ['Bash', null],
    ]);
  });

  it('breaks a tie for the top project by key, a rooted project before none', () => {
    const { rows } = aggregateTools(
      [call('Read', 'ok', { sessionId: 's4' }), call('Read', 'ok', { sessionId: 's2' })],
      { sessionRepoRoots },
    );

    expect(rows[0].topRepoRoot).toBe('/w/web');
  });

  it('splits rows by source and by project, keeping the totals whole', () => {
    const calls = [
      call('Read', 'ok', { sessionId: 's1' }),
      call('Read', 'error', { sessionId: 's2' }),
      call('Read', 'ok', { source: 'codex', sessionId: 's3' }),
      call('Read', 'ok', { sessionId: 's4' }),
    ];
    const bySource = aggregateTools(calls, { sessionRepoRoots, bySource: true });
    const byRepo = aggregateTools(calls, { sessionRepoRoots, byRepo: true });
    const byBoth = aggregateTools(calls, { sessionRepoRoots, bySource: true, byRepo: true });

    expect(bySource.rows.map((row) => [row.source, row.calls, row.errors])).toEqual([
      ['claude', 3, 1],
      ['codex', 1, 0],
    ]);
    expect(byRepo.rows.map((row) => [row.repoRoot, row.calls])).toEqual([
      ['/w/api', 2],
      ['/w/web', 1],
      [null, 1],
    ]);
    expect(byBoth.rows.map((row) => [row.source, row.repoRoot])).toEqual([
      ['claude', '/w/api'],
      ['claude', '/w/web'],
      ['claude', null],
      ['codex', '/w/api'],
    ]);
    expect(bySource.totals).toEqual(byRepo.totals);
    expect(byRepo.totals).toMatchObject({ calls: 4, errors: 1, sessions: 4, tools: 1 });
    expect(bySource.rows[0]).not.toHaveProperty('repoRoot');
    expect(byRepo.rows[0]).not.toHaveProperty('source');
  });

  it('orders rows by calls, then by name', () => {
    const { rows } = aggregateTools(
      [call('b', 'ok'), call('a', 'ok'), call('c', 'ok'), call('c', 'ok')],
      { sessionRepoRoots },
    );

    expect(rows.map((row) => row.name)).toEqual(['c', 'a', 'b']);
  });
});
