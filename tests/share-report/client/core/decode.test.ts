import { describe, expect, it } from 'vitest';

import { parseReportData } from '../../../../src/share-report/client/core/index.js';

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
