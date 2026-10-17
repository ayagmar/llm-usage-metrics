import { describe, expect, it } from 'vitest';

import {
  decodeViewState,
  encodeViewState,
  getDefaultViewState,
  TABLE_SORT_KEYS,
  type ShareReport,
  type ShareViewState,
} from '../../../../src/share-report/client/core/index.js';
import { getDateKeyRange } from '../../../../src/utils/date-key.js';
import { mulberry32, pick, randomInt, type Random } from '../../../helpers/seeded-random.js';
import { defined, loadFixtureReport } from './share-fixture.js';

function randomSubset(random: Random, size: number): number[] {
  return Array.from({ length: size }, (_, index) => index).filter(() => random() < 0.4);
}

function randomViewState(random: Random, report: ShareReport): ShareViewState {
  const { dictionaries, meta } = report.data;
  const dates = getDateKeyRange(
    defined(meta.window.since ?? undefined),
    defined(meta.window.until ?? undefined),
  );
  const [since, until] = [pick(random, dates), pick(random, dates)].sort();

  return {
    since: random() < 0.2 ? null : since,
    until: random() < 0.2 ? null : until,
    granularity: pick(random, ['hour', 'day', 'week', 'month'] as const),
    source: randomSubset(random, dictionaries.sources.length),
    model: randomSubset(random, dictionaries.models.length),
    project: randomSubset(random, dictionaries.projects.length),
    machine: randomSubset(random, dictionaries.machines.length),
    costMode: pick(random, ['explicit', 'estimated', 'both'] as const),
    stackBy: pick(random, ['source', 'model', 'project', 'machine'] as const),
    theme: pick(random, ['auto', 'light', 'dark'] as const),
    sort: { key: pick(random, TABLE_SORT_KEYS), direction: pick(random, ['asc', 'desc'] as const) },
    drill: random() < 0.5 ? null : randomInt(random, dictionaries.projects.length),
  };
}

describe('view state hash', () => {
  const report = loadFixtureReport();
  const defaults = getDefaultViewState(report);

  it('opens on the command view, every label and the command cost mode', () => {
    expect(defaults).toEqual({
      since: '2026-10-20',
      until: '2026-10-26',
      granularity: 'day',
      source: [],
      model: [],
      project: [],
      machine: [],
      costMode: 'both',
      stackBy: 'source',
      theme: 'auto',
      sort: { key: 'cost', direction: 'desc' },
      drill: null,
    });
    expect(encodeViewState(defaults, report)).toBe('');
  });

  it('round-trips any valid view', () => {
    const random = mulberry32(0x5eed);

    for (let run = 0; run < 500; run += 1) {
      const state = randomViewState(random, report);
      const hash = encodeViewState(state, report);

      expect(decodeViewState(`#${hash}`, report), hash).toEqual(state);
      expect(decodeViewState(hash, report), hash).toEqual(state);
    }
  });

  it('writes filters as dictionary indexes, never labels', () => {
    const hash = encodeViewState({ ...defaults, project: [2, 0], machine: [1] }, report);

    expect(hash).toBe('proj=0.2&mach=1');
    expect(hash).not.toContain('alpha');
  });

  it.each([
    ['an index past its dictionary', 'proj=0.9', { project: [] }],
    ['a negative or fractional index', 'src=-1&model=0.5x', { source: [], model: [] }],
    ['a date outside the window', 'from=2024-01-01', { since: '2026-10-20' }],
    ['a date that does not exist', 'to=2026-02-30', { until: '2026-10-26' }],
    [
      'a reversed range',
      'from=2026-10-26&to=2026-10-20',
      { since: '2026-10-20', until: '2026-10-26' },
    ],
    ['an unknown granularity', 'g=year', { granularity: 'day' }],
    ['an unknown sort key', 'sort=-sessionId', { sort: { key: 'cost', direction: 'desc' } }],
    [
      'an unknown theme and dimension',
      'theme=neon&stack=provider',
      { theme: 'auto', stackBy: 'source' },
    ],
    ['a drill-down past the projects', 'drill=3', { drill: null }],
    ['a drill-down that is not one index', 'drill=0.1', { drill: null }],
    ['a malformed escape', 'g=%E0%A4%A&theme=dark', { granularity: 'day', theme: 'dark' }],
  ])('keeps the default for %s', (_name, hash, expected) => {
    expect(decodeViewState(hash, report)).toEqual({ ...defaults, ...expected });
  });

  it('reads an open range end and the last of duplicate keys', () => {
    expect(decodeViewState('from=&g=hour&g=week', report)).toMatchObject({
      since: null,
      granularity: 'week',
    });
  });

  it('drops a cost mode the file lacks', () => {
    const explicitOnly = loadFixtureReport((data) => {
      delete data.cube.costs.estimated;
      delete data.cube.costs.both;
      data.meta.unavailableCostModes = ['estimated', 'both'];
      data.meta.costMode = 'explicit';
    });

    expect(decodeViewState('cost=estimated', explicitOnly).costMode).toBe('explicit');
    expect(decodeViewState('cost=both', report).costMode).toBe('both');
  });

  it('never throws on arbitrary text', () => {
    const random = mulberry32(42);
    const alphabet = Array.from('#&=.-%0123456789abcdefgromtsupj ');

    for (let run = 0; run < 500; run += 1) {
      const text = Array.from({ length: randomInt(random, 40) }, () => pick(random, alphabet)).join(
        '',
      );
      const state = decodeViewState(text, report);

      expect(decodeViewState(encodeViewState(state, report), report)).toEqual(state);
    }
  });
});
