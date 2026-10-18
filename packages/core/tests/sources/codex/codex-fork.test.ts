import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../../../src/domain/session-event.js';
import { CodexSourceAdapter } from '../../../src/sources/codex/index.js';
import { collect } from '../../../src/stream/collect.js';
import { readEvents } from '../../../src/stream/read-events.js';
import { fixturePath } from '../../helpers/fixtures.js';

// A parent with two turns (2,760 tokens on 2026-01-01) and forks of it whose own turn adds
// 540 tokens on 2026-01-02. The copied lines carry the fork's time, as Codex writes them,
// and include a settings event the parent owns, which must not end the copied block.
const FORK_DIR = fixturePath(import.meta.url, '../../fixtures/codex-fork');
const FORK_ID = '019a0000-0000-7000-8000-00000000000b';

const adapter = new CodexSourceAdapter();

async function usageTotals(fileName: string): Promise<{ total: number; byDay: object }> {
  const events = await collect(adapter.read(path.join(FORK_DIR, fileName)));
  const byDay: Record<string, number> = {};

  for (const event of events) {
    const day = event.timestamp.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + event.totalTokens;
  }

  return { total: events.reduce((sum, event) => sum + event.totalTokens, 0), byDay };
}

async function readAll(fileName: string): Promise<SessionEvent[]> {
  return collect(readEvents(adapter, path.join(FORK_DIR, fileName)));
}

describe('Codex forks', () => {
  it('reads the parent on its own day', async () => {
    await expect(usageTotals('parent.jsonl')).resolves.toEqual({
      total: 2760,
      byDay: { '2026-01-01': 2760 },
    });
  });

  // fork-referenced-usage-limit.jsonl: a fork written by Codex 0.153, whose first turn
  // hits the usage limit and logs the parent's running totals before its own turn.
  it.each(['fork-copied.jsonl', 'fork-referenced.jsonl', 'fork-referenced-usage-limit.jsonl'])(
    'counts only the fork’s own turn in %s',
    async (fileName) => {
      await expect(usageTotals(fileName)).resolves.toEqual({
        total: 540,
        byDay: { '2026-01-02': 540 },
      });
    },
  );

  it('yields nothing from the copied lines of a copied fork', async () => {
    const events = await readAll('fork-copied.jsonl');

    expect(events.every((event) => event.sessionId === FORK_ID)).toBe(true);
    expect(events.map((event) => [event.kind, event.timestamp])).toEqual([
      ['session_meta', '2026-01-02T09:00:00.000Z'],
      ['session_meta', '2026-01-02T09:00:01.000Z'],
      ['message', '2026-01-02T09:00:02.000Z'],
      ['tool_call', '2026-01-02T09:00:03.000Z'],
      ['message', '2026-01-02T09:00:05.000Z'],
      ['usage', '2026-01-02T09:00:06.000Z'],
    ]);
  });

  it('reads the same events from a copied fork as from a referenced one', async () => {
    const copied = await readAll('fork-copied.jsonl');
    const referenced = await readAll('fork-referenced.jsonl');

    expect(copied.filter((event) => event.kind !== 'session_meta')).toEqual(
      referenced.filter((event) => event.kind !== 'session_meta'),
    );
  });

  it('keeps counting the copied lines of a fork written without the closing event', async () => {
    // Codex before 0.152 does not mark where the copied lines end.
    await expect(usageTotals('fork-legacy.jsonl')).resolves.toEqual({
      total: 3300,
      byDay: { '2026-01-02': 3300 },
    });

    const events = await readAll('fork-legacy.jsonl');
    expect(events.every((event) => event.sessionId === FORK_ID)).toBe(true);
    expect(events.filter((event) => event.kind === 'usage')).toHaveLength(3);
  });
});
