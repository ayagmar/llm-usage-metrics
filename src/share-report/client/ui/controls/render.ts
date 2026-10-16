// The control bar. Built once from the models; `sync` sets every input from the state after
// each change, so the bar never re-creates an input the user is in.

import type { ShareCostMode, ShareGranularity } from '../../../types.js';
import type { ShareDimension, ShareReport, ShareTheme } from '../../core/index.js';
import { h } from '../shell/dom.js';
import type { ShareLabels } from '../state/context.js';
import {
  clearFilters,
  getPeriodPresets,
  hasLabelFilters,
  resetView,
  toggleIndex,
  withFilter,
  withPeriod,
  withView,
  type ShareUiState,
} from '../state/view.js';
import {
  countDimensionTokens,
  getCostModeOptions,
  getFilterGroups,
  getGranularityOptions,
  getStackOptions,
  type Option,
} from './model.js';

export type Update = (change: (state: ShareUiState) => ShareUiState) => void;

export type Controls = {
  element: HTMLElement;
  sync: (state: ShareUiState, labels: ShareLabels) => void;
};

const THEME_OPTIONS: Option<ShareTheme>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** A row of radio buttons drawn as one segmented control. */
function segmented<Value extends string>(
  name: string,
  legend: string,
  options: Option<Value>[],
  onPick: (value: Value) => void,
): { element: HTMLFieldSetElement; sync: (value: Value) => void } {
  const inputs = options.map((option) => {
    const input = h('input', {
      attrs: {
        type: 'radio',
        name,
        value: option.value,
        'data-focus': `${name}-${option.value}`,
        disabled: option.disabledReason !== undefined,
      },
    });
    input.addEventListener('change', () => {
      onPick(option.value);
    });
    return { option, input };
  });
  const element = h('fieldset', { class: 'control segmented' }, [
    h('legend', { class: 'control-label', text: legend }),
    h(
      'div',
      { class: 'segments' },
      inputs.map(({ option, input }) =>
        h('label', { class: 'segment', attrs: { title: option.detail ?? option.disabledReason } }, [
          input,
          h('span', { text: option.label }),
        ]),
      ),
    ),
  ]);

  return {
    element,
    sync: (value) => {
      for (const { option, input } of inputs) {
        input.checked = option.value === value;
      }
    },
  };
}

function select<Value extends string>(
  id: string,
  label: string,
  options: Option<Value>[],
  onPick: (value: Value) => void,
): { element: HTMLElement; sync: (value: Value) => void } {
  const input = h(
    'select',
    { attrs: { id, 'data-focus': id } },
    options.map((option) =>
      h('option', {
        attrs: { value: option.value, disabled: option.disabledReason !== undefined },
        text:
          option.disabledReason === undefined
            ? `${option.label}${option.detail ? ` — ${option.detail}` : ''}`
            : `${option.label} (${option.disabledReason.toLowerCase()})`,
      }),
    ),
  );
  input.addEventListener('change', () => {
    const picked = options.find((option) => option.value === input.value);

    if (picked) {
      onPick(picked.value);
    }
  });

  return {
    element: h('div', { class: 'control' }, [
      h('label', { class: 'control-label', attrs: { for: id }, text: label }),
      h('div', { class: 'select' }, [input]),
    ]),
    sync: (value) => {
      input.value = value;
    },
  };
}

function periodControl(report: ShareReport, update: Update) {
  const { window } = report.data.meta;
  const presets = getPeriodPresets(report);
  const dateInput = (id: string) =>
    h('input', {
      attrs: {
        id,
        type: 'date',
        'data-focus': id,
        min: window.since ?? undefined,
        max: window.until ?? undefined,
      },
    });
  const from = dateInput('period-from');
  const to = dateInput('period-to');
  const onDates = () => {
    update((state) => withPeriod(state, report, from.value || null, to.value || null));
  };
  from.addEventListener('change', onDates);
  to.addEventListener('change', onDates);

  const buttons = presets.map((preset) => {
    const button = h('button', {
      class: 'chip',
      attrs: { type: 'button', 'data-focus': `preset-${preset.id}`, 'aria-pressed': 'false' },
      text: preset.label,
    });
    button.addEventListener('click', () => {
      update((state) => withPeriod(state, report, preset.since, preset.until));
    });
    return { preset, button };
  });

  return {
    element: h('fieldset', { class: 'control period-control' }, [
      h('legend', { class: 'control-label', text: 'Period' }),
      h('div', { class: 'dates' }, [
        h('label', { class: 'visually-hidden', attrs: { for: 'period-from' }, text: 'From' }),
        from,
        h('span', { class: 'dates-to', attrs: { 'aria-hidden': 'true' }, text: 'to' }),
        h('label', { class: 'visually-hidden', attrs: { for: 'period-to' }, text: 'To' }),
        to,
      ]),
      h(
        'div',
        { class: 'chips' },
        buttons.map(({ button }) => button),
      ),
    ]),
    sync: (state: ShareUiState) => {
      from.value = state.view.since ?? '';
      to.value = state.view.until ?? '';
      // An open end of the view picks no date; keep the other end's bounds honest.
      from.max = state.view.until ?? window.until ?? '';
      to.min = state.view.since ?? window.since ?? '';

      for (const { preset, button } of buttons) {
        button.setAttribute(
          'aria-pressed',
          String(preset.since === state.view.since && preset.until === state.view.until),
        );
      }
    },
  };
}

/** A filter dropdown per dimension: a disclosure with one checkbox per label. */
function filterControl(report: ShareReport, update: Update) {
  const tokens = countDimensionTokens(report);
  const container = h('div', { class: 'filters' });
  const open = new Set<ShareDimension>();

  const sync = (state: ShareUiState, labels: ShareLabels) => {
    const groups = getFilterGroups(report, tokens, state.view, labels);

    container.replaceChildren(
      ...groups.map((group) => {
        const list = h(
          'ul',
          { class: 'filter-options' },
          group.options.map((option) => {
            const input = h('input', {
              attrs: {
                type: 'checkbox',
                'data-focus': `filter-${group.dimension}-${option.index}`,
                checked: option.selected,
              },
            });
            input.addEventListener('change', () => {
              update((current) =>
                withFilter(
                  current,
                  group.dimension,
                  toggleIndex(current.view[group.dimension], option.index),
                ),
              );
            });
            return h('li', {}, [
              h('label', { class: 'check' }, [input, h('span', { text: option.label })]),
            ]);
          }),
        );
        const clear = h('button', {
          class: 'link-button',
          attrs: {
            type: 'button',
            'data-focus': `filter-${group.dimension}-clear`,
            disabled: !group.filtered,
          },
          text: 'Show all',
        });
        clear.addEventListener('click', () => {
          update((current) => withFilter(current, group.dimension, []));
        });

        const details = h(
          'details',
          { class: 'filter', attrs: { open: open.has(group.dimension) } },
          [
            h('summary', { attrs: { 'data-focus': `filter-${group.dimension}` } }, [
              h('span', { class: 'control-label', text: group.title }),
              h('span', { class: 'filter-summary', text: group.summary }),
            ]),
            h('div', { class: 'filter-panel' }, [list, clear]),
          ],
        );
        details.addEventListener('toggle', () => {
          if (details.open) {
            open.add(group.dimension);
          } else {
            open.delete(group.dimension);
          }
        });
        details.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && details.open) {
            details.open = false;
            details.querySelector('summary')?.focus();
          }
        });
        return details;
      }),
    );
  };

  // A click outside an open filter closes it, as a menu would.
  document.addEventListener('click', (event) => {
    for (const details of container.querySelectorAll('details[open]')) {
      if (event.target instanceof Node && !details.contains(event.target)) {
        details.removeAttribute('open');
      }
    }
  });

  return { element: container, sync };
}

export function createControls(report: ShareReport, update: Update): Controls {
  const period = periodControl(report, update);
  const granularity = segmented<ShareGranularity>(
    'granularity',
    'Group by',
    getGranularityOptions(report),
    (value) => {
      update((state) => withView(state, { granularity: value }));
    },
  );
  const filters = filterControl(report, update);
  const costOptions = getCostModeOptions(report);
  const cost =
    costOptions.length === 0
      ? undefined
      : select<ShareCostMode>('cost-mode', 'Cost', costOptions, (value) => {
          update((state) => withView(state, { costMode: value }));
        });
  const stack = select<ShareDimension>(
    'stack-by',
    'Split charts by',
    getStackOptions(),
    (value) => {
      update((state) => withView(state, { stackBy: value }));
    },
  );
  const theme = segmented<ShareTheme>('theme', 'Theme', THEME_OPTIONS, (value) => {
    update((state) => ({ ...state, view: { ...state.view, theme: value } }));
  });
  const hideNames = h('input', {
    attrs: { type: 'checkbox', id: 'hide-names', 'data-focus': 'hide-names', role: 'switch' },
  });
  hideNames.addEventListener('change', () => {
    update((state) => ({ ...state, hideNames: hideNames.checked }));
  });
  const reset = h('button', {
    class: 'link-button',
    attrs: { type: 'button', 'data-focus': 'reset-view' },
    text: 'Reset view',
  });
  reset.addEventListener('click', () => {
    update((state) => resetView(state, report));
  });
  const clear = h('button', {
    class: 'link-button',
    attrs: { type: 'button', 'data-focus': 'clear-filters' },
    text: 'Clear filters',
  });
  clear.addEventListener('click', () => {
    update(clearFilters);
  });

  const element = h('section', { class: 'controls', attrs: { 'aria-label': 'View' } }, [
    h('div', { class: 'controls-row' }, [period.element, granularity.element]),
    h('div', { class: 'controls-row' }, [
      h('div', { class: 'control' }, [
        h('span', { class: 'control-label', attrs: { id: 'filters-label' }, text: 'Filter' }),
        filters.element,
      ]),
      cost?.element,
      stack.element,
    ]),
    h('div', { class: 'controls-row controls-display' }, [
      theme.element,
      h('div', { class: 'control' }, [
        h('label', { class: 'switch', attrs: { for: 'hide-names' } }, [
          hideNames,
          h('span', { class: 'switch-text' }, [
            h('span', { text: 'Hide names' }),
            h('span', {
              class: 'switch-hint',
              text: 'On screen and in exports only; the file is unchanged',
            }),
          ]),
        ]),
      ]),
      h('div', { class: 'control control-actions' }, [clear, reset]),
    ]),
  ]);

  return {
    element,
    sync: (state, labels) => {
      period.sync(state);
      granularity.sync(state.view.granularity);
      filters.sync(state, labels);

      if (cost && state.view.costMode !== null) {
        cost.sync(state.view.costMode);
      }

      stack.sync(state.view.stackBy);
      theme.sync(state.view.theme);
      hideNames.checked = state.hideNames;
      clear.disabled = !hasLabelFilters(state.view);
    },
  };
}
