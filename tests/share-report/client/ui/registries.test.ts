import { describe, expect, it } from 'vitest';

import { SHARE_CHARTS } from '../../../../src/share-report/client/ui/charts/index.js';
import { SHARE_PANELS } from '../../../../src/share-report/client/ui/panels/index.js';

// Ids name element ids and export files (`<base>-<id>-<theme>.png`), so they must be unique
// across both registries and safe in a URL, an id attribute and a file name.
describe('chart and panel registries', () => {
  const ids = [...SHARE_CHARTS.map((chart) => chart.id), ...SHARE_PANELS.map((panel) => panel.id)];

  it('use unique ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('use lower-case, dash-separated ids', () => {
    for (const id of ids) {
      expect(id).toMatch(/^[a-z\d]+(?:-[a-z\d]+)*$/u);
    }
  });

  it('give every entry a title', () => {
    for (const entry of [...SHARE_CHARTS, ...SHARE_PANELS]) {
      expect(entry.title.trim()).not.toBe('');
    }
  });
});
