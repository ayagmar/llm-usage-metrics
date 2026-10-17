import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collect, createSourceContext } from '@ayagmar/agent-sessions';
import { readSources } from '@ayagmar/agent-sessions/registry';
import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_SOURCES, writeDemoData } from '../../site/scripts/demo-data.mjs';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function demoUsageTimes(now: number): Promise<string[]> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'demo-data-'));
  homes.push(home);
  const { dirs } = await writeDemoData({ home, now, days: 3 });
  const roots = new Map(DEMO_SOURCES.map((source) => [source, [dirs[source]]]));
  const events = await collect(
    readSources(createSourceContext({ homeDir: home, env: {} }), [...DEMO_SOURCES], {
      kinds: ['usage'],
      roots,
    }),
  );
  return events.map((event) => event.timestamp);
}

describe('writeDemoData', () => {
  // The hourly and statusline screenshots show the run date, so it needs usage at any hour.
  it.each(['2026-10-17T00:00:00.000Z', '2026-10-17T00:03:00.000Z', '2026-10-17T06:00:00.000Z'])(
    'writes usage on the run date for a run at %s, none after it',
    async (runAt) => {
      const now = Date.parse(runAt);
      const times = (await demoUsageTimes(now)).map((timestamp) => Date.parse(timestamp));

      expect(times.filter((time) => time >= Date.parse('2026-10-17T00:00:00.000Z')).length).toBeGreaterThan(0);
      expect(times.filter((time) => time > now)).toEqual([]);
    },
  );

  it('keeps a late run date spread over the working day', async () => {
    const now = Date.parse('2026-10-17T23:30:00.000Z');
    const hours = new Set(
      (await demoUsageTimes(now))
        .filter((timestamp) => timestamp.startsWith('2026-10-17'))
        .map((timestamp) => timestamp.slice(11, 13)),
    );

    expect(hours.size).toBeGreaterThan(1);
  });
});
