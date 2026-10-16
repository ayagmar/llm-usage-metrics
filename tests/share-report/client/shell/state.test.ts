import { describe, expect, it } from 'vitest';

import {
  encodeViewState,
  getDefaultViewState,
} from '../../../../src/share-report/client/core/index.js';
import {
  escapeJsonForScript,
  escapeHtml,
  parseSavedView,
  serializeSavedView,
} from '../../../../src/share-report/client/ui/export/share-document.js';
import {
  buildViewContext,
  createLabels,
  createMaskSource,
  HIDDEN_LABEL,
} from '../../../../src/share-report/client/ui/state/context.js';
import {
  clearFilters,
  getLastDate,
  getPeriodPresets,
  hasLabelFilters,
  nextSort,
  resetView,
  resolveInitialView,
  resolveTheme,
  toggleIndex,
  withFilter,
  withPeriod,
  withView,
  type ShareUiState,
} from '../../../../src/share-report/client/ui/state/view.js';
import { loadFixtureReport } from '../core/share-fixture.js';

const report = loadFixtureReport();

function initialState(): ShareUiState {
  return { view: getDefaultViewState(report), hideNames: false, page: 2 };
}

describe('the view a page opens on', () => {
  it('prefers the URL hash, then a saved view, then the command view', () => {
    expect(resolveInitialView('#g=week', 'g=month', report).granularity).toBe('week');
    expect(resolveInitialView('', 'g=month', report).granularity).toBe('month');
    expect(resolveInitialView('#', 'g=month', report).granularity).toBe('month');
    expect(resolveInitialView('', undefined, report)).toEqual(getDefaultViewState(report));
  });

  it('falls back field by field on a stale or hostile hash', () => {
    const view = resolveInitialView(
      '#g=year&src=9&proj=1&from=1999-01-01&cost=%E0',
      undefined,
      report,
    );

    expect(view.granularity).toBe('day');
    expect(view.source).toEqual([]);
    expect(view.project).toEqual([1]);
    expect(view.since).toBe('2026-10-20');
  });

  it('round-trips a saved view through its script element', () => {
    const view = { ...getDefaultViewState(report), granularity: 'week' as const, project: [0, 2] };
    const hash = encodeViewState(view, report);
    const saved = parseSavedView(serializeSavedView(hash));

    expect(resolveInitialView('', saved, report)).toEqual(view);
    expect(parseSavedView('{"hash":1}')).toBeUndefined();
    expect(parseSavedView('not json')).toBeUndefined();
    expect(parseSavedView(null)).toBeUndefined();
  });
});

describe('view changes', () => {
  it('sends the table back to its first page when the rows change', () => {
    const state = initialState();

    expect(withView(state, { granularity: 'week' }).page).toBe(0);
    expect(withFilter(state, 'model', [1]).view.model).toEqual([1]);
    expect(withFilter(state, 'model', [1]).page).toBe(0);
  });

  it('keeps the period when a change would invert it or leave the window', () => {
    const state = initialState();

    expect(withPeriod(state, report, '2026-10-26', '2026-10-20')).toBe(state);
    expect(withPeriod(state, report, '2025-01-01', '2026-10-20')).toBe(state);
    expect(withPeriod(state, report, '2026-10-01', '2026-11-30')).toBe(state);
    expect(withPeriod(state, report, null, '2026-10-21').view).toMatchObject({
      since: null,
      until: '2026-10-21',
    });
  });

  it('toggles filter indexes in sorted order', () => {
    expect(toggleIndex([2], 0)).toEqual([0, 2]);
    expect(toggleIndex([0, 2], 2)).toEqual([0]);
  });

  it('flips the sorted column and starts a new one in its natural direction', () => {
    expect(nextSort({ key: 'cost', direction: 'desc' }, 'cost')).toEqual({
      key: 'cost',
      direction: 'asc',
    });
    expect(nextSort({ key: 'cost', direction: 'asc' }, 'cost')).toEqual({
      key: 'cost',
      direction: 'desc',
    });
    expect(nextSort({ key: 'cost', direction: 'desc' }, 'label')).toEqual({
      key: 'label',
      direction: 'asc',
    });
    expect(nextSort({ key: 'label', direction: 'asc' }, 'eventCount')).toEqual({
      key: 'eventCount',
      direction: 'desc',
    });
  });

  it('resets filters or the whole view but keeps the chosen theme', () => {
    const changed = withView(withFilter(initialState(), 'source', [1]), {
      granularity: 'month',
      theme: 'dark',
    });

    expect(hasLabelFilters(changed.view)).toBe(true);
    expect(hasLabelFilters(clearFilters(changed).view)).toBe(false);
    expect(clearFilters(changed).view.granularity).toBe('month');
    expect(resetView(changed, report).view).toEqual({
      ...getDefaultViewState(report),
      theme: 'dark',
    });
  });

  it('follows the system theme only on auto', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('period presets', () => {
  it('counts back from the window end and drops presets that leave the window or repeat', () => {
    expect(getPeriodPresets(report).map(({ id, since, until }) => [id, since, until])).toEqual([
      ['opening', '2026-10-20', '2026-10-26'],
      ['last-30', '2026-09-27', '2026-10-26'],
      ['last-90', '2026-07-29', '2026-10-26'],
      ['window', '2025-12-29', '2026-10-26'],
    ]);

    const short = loadFixtureReport((data) => {
      data.meta.window.since = '2026-10-01';
    });
    // Last 7 days equals the opening view; 30 and 90 days would start before the window.
    expect(getPeriodPresets(short).map((preset) => preset.id)).toEqual(['opening', 'window']);
  });

  it('uses the newest data date when the window is open-ended', () => {
    const open = loadFixtureReport((data) => {
      data.meta.window.until = null;
    });

    expect(getLastDate(open)).toBe('2026-10-26');
  });
});

describe('labels and Hide names', () => {
  it('masks projects and machines but keeps local and unattributed', () => {
    const labels = createLabels(report, createMaskSource(report)());

    expect(labels.hidden).toBe(true);
    expect(
      report.data.dictionaries.projects.map((_, index) => labels.of('project', index)),
    ).toEqual(['project-1', 'project-2', '(unattributed)']);
    expect(labels.of('machine', 1)).toBe('machine-1');
    expect(labels.of('machine', 0)).toBe('local');
    expect(labels.of('source', 1)).toBe('codex');
    expect(labels.project('beta')).toBe('project-2');
    expect(labels.project('a/path/outside/the/file')).toBe(HIDDEN_LABEL);
    expect(labels.machine('local')).toBe('local');
  });

  it('shows labels as they are with names visible', () => {
    const labels = createLabels(report, undefined);

    expect(labels.of('project', 0)).toBe('alpha');
    expect(labels.project('anything')).toBe('anything');
  });

  it('builds the mask once per file', () => {
    const source = createMaskSource(report);
    expect(source()).toBe(source());
  });

  it('selects the cells of the view', () => {
    const context = buildViewContext(
      report,
      getDefaultViewState(report),
      createLabels(report, undefined),
      'light',
    );

    expect(context.cells).toEqual([3, 4, 5, 6, 7]);
    expect(context.span).toEqual({ first: '2026-10-20', last: '2026-10-26' });
  });
});

describe('document escapes', () => {
  it('escapes markup characters for text and attributes', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('keeps JSON equal after escaping it for a script element', () => {
    const value = { label: '</script><!-- \u2028\u2029 <b>' };
    const escaped = escapeJsonForScript(JSON.stringify(value));

    expect(escaped).not.toMatch(/[<\u2028\u2029]/u);
    expect(JSON.parse(escaped)).toEqual(value);
  });
});
