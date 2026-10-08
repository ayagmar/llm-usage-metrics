import { describe, expect, it } from 'vitest';

import { LOCAL_MACHINE_NAME } from '../../src/config/user-config.js';
import { createUsageEvent, type UsageEvent } from '../../src/domain/usage-event.js';
import { selectMachines } from '../../src/machines/load-machine-usage.js';
import { mergeMachineEvents } from '../../src/machines/merge-machine-events.js';

function event(sessionId: string, minute: number): UsageEvent {
  return createUsageEvent({
    source: 'claude',
    sessionId,
    timestamp: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
    inputTokens: 100,
    outputTokens: 10,
    costMode: 'estimated',
  });
}

describe('mergeMachineEvents', () => {
  it('leaves out a session copied to another machine, but keeps its later turns', () => {
    const local = [event('s1', 0), event('s1', 1)];
    const [laptop] = mergeMachineEvents(local, [
      { name: 'laptop', events: [event('s1', 0), event('s1', 1), event('s1', 2), event('s2', 0)] },
    ]);

    expect(laptop.events).toEqual([event('s1', 2), event('s2', 0)]);
    expect(laptop.duplicateCount).toBe(2);
  });

  it('matches each counted event once, so genuine repeats survive', () => {
    const [laptop] = mergeMachineEvents(
      [event('s1', 0)],
      [{ name: 'laptop', events: [event('s1', 0), event('s1', 0)] }],
    );

    expect(laptop.events).toEqual([event('s1', 0)]);
    expect(laptop.duplicateCount).toBe(1);
  });

  it('checks each machine against everything counted before it', () => {
    const [laptop, vps] = mergeMachineEvents(
      [event('local', 0)],
      [
        { name: 'laptop', events: [event('local', 0), event('shared', 0)] },
        { name: 'vps', events: [event('local', 0), event('shared', 0), event('vps', 0)] },
      ],
    );

    expect(laptop).toMatchObject({ events: [event('shared', 0)], duplicateCount: 1 });
    expect(vps).toMatchObject({ events: [event('vps', 0)], duplicateCount: 2 });
  });
});

describe('selectMachines', () => {
  const machines = { laptop: { ssh: 'laptop' }, vps: { ssh: 'vps' } };

  it('counts this machine and every configured one by default', () => {
    expect(selectMachines(machines, undefined, { customSourceDirectories: false })).toEqual({
      includeLocal: true,
      names: ['laptop', 'vps'],
    });
  });

  it('leaves other machines out of a run pointed at custom source directories', () => {
    expect(selectMachines(machines, undefined, { customSourceDirectories: true })).toEqual({
      includeLocal: true,
      names: [],
    });
  });

  it('counts only the machines --machine names', () => {
    expect(selectMachines(machines, new Set(['vps']), { customSourceDirectories: true })).toEqual({
      includeLocal: false,
      names: ['vps'],
    });
    expect(
      selectMachines(machines, new Set([LOCAL_MACHINE_NAME]), { customSourceDirectories: false }),
    ).toEqual({ includeLocal: true, names: [] });
  });

  it('rejects names that are not configured', () => {
    expect(() =>
      selectMachines(machines, new Set(['desk']), { customSourceDirectories: false }),
    ).toThrow('Unknown machine(s) for --machine: desk (known: local, laptop, vps)');
  });
});
