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
  it('shows the wrapped recap above the controls and the other panels after the charts', () => {
    expect(getPanelsFor(reportWith('wrapped'), SHARE_PANELS)).toMatchObject({
      recap: [{ id: 'wrapped-recap' }],
      section: [],
    });

    for (const report of ['compare', 'efficiency', 'optimize'] as const) {
      const panels = getPanelsFor(reportWith(report), SHARE_PANELS);
      expect(panels.recap).toEqual([]);
      expect(panels.section.map((panel) => panel.id)).toEqual([report]);
    }
  });

  it('adds no panel to a file without an envelope', () => {
    expect(getPanelsFor(reportWith(undefined), SHARE_PANELS)).toEqual({ recap: [], section: [] });
  });
});
