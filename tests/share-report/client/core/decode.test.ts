import { describe, expect, it } from 'vitest';

import {
  decodeShareReport,
  parseReportData,
  toLocalDateHour,
} from '../../../../src/share-report/client/core/index.js';
import { decodeOrThrow, defined, readFixturePayload } from './share-fixture.js';

type Payload = ReturnType<typeof readFixturePayload>;

describe('parseReportData', () => {
  it('parses the embedded payload', () => {
    expect(parseReportData('{"schemaVersion":1,"report":"share"}')).toEqual({
      schemaVersion: 1,
      report: 'share',
    });
  });

  it.each([null, undefined, '', '{"unterminated"'])(
    'returns undefined instead of throwing for %j',
    (text) => {
      expect(parseReportData(text)).toBeUndefined();
    },
  );
});

describe('decodeShareReport', () => {
  it('decodes the fixture and parses its period keys once', () => {
    const report = decodeOrThrow(readFixturePayload());

    expect(report.cellCount).toBe(8);
    expect(report.periods[0]).toEqual({
      key: '2025-12-31',
      dateKey: '2025-12-31',
      weekKey: '2026-W01',
      monthKey: '2025-12',
      weekday: 3,
      hour: null,
    });
    expect(report.periods[5]).toMatchObject({ key: '2026-10-25 02:00', hour: 2, weekday: 7 });
  });

  it.each([
    [
      'not a share report',
      (payload: Payload) => {
        Object.assign(payload, { schemaVersion: 2 });
      },
    ],
    [
      'missing data',
      (payload: Payload) => {
        Reflect.deleteProperty(payload, 'data');
      },
    ],
    [
      'a dictionary that is not labels',
      (payload: Payload) => {
        payload.data.dictionaries.models = [1] as unknown as string[];
      },
    ],
    [
      'an unknown timezone',
      (payload: Payload) => {
        payload.data.meta.timezone = 'Mars/Olympus';
      },
    ],
    [
      'incomplete meta',
      (payload: Payload) => {
        Reflect.deleteProperty(payload.data.meta, 'window');
      },
    ],
    [
      'no unavailable cost modes',
      (payload: Payload) => {
        Reflect.deleteProperty(payload.data.meta, 'unavailableCostModes');
      },
    ],
    [
      'a short column',
      (payload: Payload) => {
        payload.data.cube.totalTokens.pop();
      },
    ],
    [
      'an index past its dictionary',
      (payload: Payload) => {
        payload.data.cube.machine[0] = 2;
      },
    ],
    [
      'a missing period column',
      (payload: Payload) => {
        Reflect.deleteProperty(payload.data.cube, 'period');
      },
    ],
    [
      'a non-finite measure',
      (payload: Payload) => {
        payload.data.cube.activeMs[0] = Number.NaN;
      },
    ],
    [
      'no cost columns',
      (payload: Payload) => {
        Reflect.deleteProperty(payload.data.cube, 'costs');
      },
    ],
    [
      'an unknown cost mode',
      (payload: Payload) => {
        Object.assign(payload.data.cube.costs, { list: payload.data.cube.costs.both });
      },
    ],
    [
      'a cost that is not a number',
      (payload: Payload) => {
        defined(payload.data.cube.costs.both).costUsd[0] = '0.1' as unknown as number;
      },
    ],
    [
      'a malformed period key',
      (payload: Payload) => {
        payload.data.dictionaries.periods[3] = '2026-10-20 9:00';
      },
    ],
    [
      'an hour past 23',
      (payload: Payload) => {
        payload.data.dictionaries.periods[3] = '2026-10-20 24:00';
      },
    ],
    [
      'a session of an unknown project',
      (payload: Payload) => {
        payload.data.sessions.rows[0].project = 7;
      },
    ],
    [
      'missing sessions',
      (payload: Payload) => {
        Reflect.deleteProperty(payload.data, 'sessions');
      },
    ],
    [
      'a block of an unknown source',
      (payload: Payload) => {
        payload.data.blocks.rows[0].source = 2;
      },
    ],
  ])('rejects %s with a message', (_name, edit) => {
    const payload = readFixturePayload();
    edit(payload);
    const result = decodeShareReport(payload);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).not.toBe('');
  });
});

describe('toLocalDateHour', () => {
  it('reads an instant in the report timezone across a DST fall-back', () => {
    expect(toLocalDateHour('2026-10-25T00:30:00.000Z', 'Europe/Paris')).toEqual({
      dateKey: '2026-10-25',
      hour: 2,
    });
    expect(toLocalDateHour('2026-10-25T01:30:00.000Z', 'Europe/Paris')).toEqual({
      dateKey: '2026-10-25',
      hour: 2,
    });
    expect(toLocalDateHour('2026-10-26T22:05:00.000Z', 'Pacific/Apia')).toEqual({
      dateKey: '2026-10-27',
      hour: 11,
    });
    expect(toLocalDateHour('not a time', 'UTC')).toBeUndefined();
  });
});
