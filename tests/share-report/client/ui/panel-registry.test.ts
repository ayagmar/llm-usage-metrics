import { describe, expect, it } from 'vitest';

import type { ShareReport } from '../../../../src/share-report/client/core/index.js';
import { SHARE_PANELS } from '../../../../src/share-report/client/ui/panels/index.js';
import { getPanelsFor } from '../../../../src/share-report/client/ui/shell/model.js';
import type { ShareEmbeddedEnvelope } from '../../../../src/share-report/types.js';

// `appliesTo` reads only the envelope's report name.
function reportWith(report: ShareEmbeddedEnvelope['report'] | undefined): ShareReport {
  const envelope = report && { schemaVersion: 1, report, data: {} };
  return { data: { envelope } } as unknown as ShareReport;
}

describe('panel registry', () => {
  it('gives each command with its own report one lead, above the controls', () => {
    for (const [report, id] of [
      ['wrapped', 'wrapped-recap'],
      ['summary', 'summary'],
      ['trends', 'trends'],
      ['compare', 'compare'],
      ['efficiency', 'efficiency'],
      ['optimize', 'optimize'],
    ] as const) {
      expect(getPanelsFor(reportWith(report), SHARE_PANELS).map((panel) => panel.id)).toEqual([id]);
    }
  });

  it('adds no panel to a file without an envelope', () => {
    expect(getPanelsFor(reportWith(undefined), SHARE_PANELS)).toEqual([]);
  });
});
