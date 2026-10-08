import { describe, expect, it } from 'vitest';

import {
  formatAge,
  formatMachinesNote,
  renderMachineList,
  renderSyncOutcome,
} from '../../src/render/render-machines.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const MINUTE = 60_000;

describe('formatAge', () => {
  it.each([
    [30_000, 'just now'],
    [5 * MINUTE, '5 min ago'],
    [3 * 60 * MINUTE, '3 h ago'],
    [3 * 24 * 60 * MINUTE, '3 days ago'],
  ])('formats %i ms', (ageMs, text) => {
    expect(formatAge(ageMs)).toBe(text);
  });
});

describe('renderMachineList', () => {
  const entry = (state: object | undefined, enabled?: boolean) => ({
    name: 'laptop',
    machine: enabled === undefined ? { ssh: 'me@laptop' } : { ssh: 'me@laptop', enabled },
    state,
    fileCount: 2,
    eventCount: 1200,
  });

  it('describes each machine state', () => {
    expect(
      renderMachineList(
        [
          entry(undefined),
          entry({ lastError: 'ssh failed: timed out', attemptedAt: NOW }),
          entry({ syncedAt: NOW - 5 * MINUTE }, false),
          entry({
            syncedAt: NOW - 90 * MINUTE,
            attemptedAt: NOW - MINUTE,
            lastError: 'ssh failed',
          }),
          entry({ syncedAt: NOW - 2 * MINUTE, attemptedAt: NOW - 2 * MINUTE }),
        ],
        NOW,
      ),
    ).toEqual([
      'laptop  me@laptop  never synced',
      'laptop  me@laptop  never synced: ssh failed: timed out',
      'laptop  me@laptop  disabled (cached usage stays in reports)',
      'laptop  me@laptop  synced 1 h ago, 2 file(s), 1,200 event(s); last attempt failed 1 min ago: ssh failed',
      'laptop  me@laptop  synced 2 min ago, 2 file(s), 1,200 event(s)',
    ]);
  });
});

describe('renderSyncOutcome', () => {
  it('reports a failure before any successful sync', () => {
    expect(
      renderSyncOutcome({ name: 'vps', ok: false, error: 'ssh failed', state: {} }, NOW),
    ).toEqual(['✗ vps: ssh failed (nothing cached yet)']);
  });

  it('names the remote version without a host name, then its warnings', () => {
    expect(
      renderSyncOutcome(
        {
          name: 'vps',
          ok: true,
          result: { receivedFileCount: 3072, removedFileCount: 1, fileCount: 3072, eventCount: 10 },
          remoteWarnings: ['⚠ machine export left out 2 event(s)'],
          state: { cliVersion: '1.0.0' },
        },
        NOW,
      ),
    ).toEqual([
      '✓ vps: 3,072 file(s) updated, 1 removed; 3,072 file(s), 10 event(s) cached (llm-usage-metrics 1.0.0)',
      '  vps warned: ⚠ machine export left out 2 event(s)',
    ]);
  });
});

describe('formatMachinesNote', () => {
  it('warns about a machine running another version', () => {
    expect(
      formatMachinesNote(
        [
          {
            name: 'laptop',
            enabled: true,
            state: { syncedAt: NOW - 2 * MINUTE, cliVersion: '0.9.0' },
            duplicateCount: 0,
          },
        ],
        NOW,
        '0.10.0',
      ),
    ).toBe(
      'Machines: laptop (synced 2 min ago, llm-usage-metrics 0.9.0 there; shared sessions may count twice until both run the same version).',
    );
  });

  it('says a disabled machine is not synced, instead of suggesting a sync', () => {
    expect(
      formatMachinesNote(
        [
          { name: 'old', enabled: false, duplicateCount: 0 },
          {
            name: 'vps',
            enabled: false,
            state: { syncedAt: NOW - 3 * 60 * MINUTE },
            duplicateCount: 0,
          },
        ],
        NOW,
        '1.0.0',
      ),
    ).toBe('Machines: old (disabled, nothing cached), vps (disabled, usage from 3 h ago).');
  });
});

describe('renderMachineList alignment', () => {
  it('aligns names and destinations', () => {
    expect(
      renderMachineList(
        [
          { name: 'vps', machine: { ssh: 'me@10.0.0.9' }, fileCount: 0, eventCount: 0 },
          { name: 'workstation', machine: { ssh: 'ws' }, fileCount: 0, eventCount: 0 },
        ],
        NOW,
      ),
    ).toEqual(['vps          me@10.0.0.9  never synced', 'workstation  ws           never synced']);
  });
});
