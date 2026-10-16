// Wires the page: one state, one render pass per change, the URL hash kept in step, and the
// export and save actions. Every decision is made by the pure modules it calls.

import { encodeViewState, type ShareReport } from '../../core/index.js';
import { SHARE_CHARTS } from '../charts/index.js';
import { createControls, type Update } from '../controls/render.js';
import {
  canCopyImage,
  copyPng,
  download,
  errorMessage,
  exportSvg,
  renderPng,
} from '../export/browser.js';
import {
  renderShareDocument,
  serializeSavedView,
  type ShareDocumentParts,
} from '../export/share-document.js';
import { getExportFileName } from '../export/svg-export.js';
import { SHARE_PANELS } from '../panels/index.js';
import { onSystemSchemeChange, readHash, systemPrefersDark, writeHash } from '../state/browser.js';
import {
  buildViewContext,
  createLabels,
  createMaskSource,
  type ShareViewContext,
} from '../state/context.js';
import {
  clearFilters,
  nextSort,
  resetView,
  resolveInitialView,
  resolveTheme,
  withView,
  type ShareUiState,
} from '../state/view.js';
import { buildTable } from '../tables/model.js';
import { renderTable } from '../tables/render.js';
import { h, keepFocus } from './dom.js';
import { buildHeader, buildSummary, getEmptyState, getPanelsFor } from './model.js';
import {
  renderChartFrame,
  renderEmptyState,
  renderHeaderContent,
  renderPanelFrame,
  renderSummary,
} from './render.js';

/** The file as it was opened: what "Save this view" rebuilds from. */
export type PristineDocument = Omit<ShareDocumentParts, 'viewStateJson'> & {
  /** The view a saved file carries, if any. */
  savedHash: string | undefined;
};

function focusKey(root: HTMLElement, key: string): void {
  const element = root.querySelector(`[data-focus="${CSS.escape(key)}"]`);

  if (element instanceof HTMLElement) {
    element.focus();
  }
}

export function startApp(root: HTMLElement, report: ShareReport, pristine: PristineDocument): void {
  const maskSource = createMaskSource(report);
  const panels = getPanelsFor(report, SHARE_PANELS);
  let state: ShareUiState = {
    view: resolveInitialView(readHash(), pristine.savedHash, report),
    hideNames: false,
    page: 0,
  };
  let context: ShareViewContext | undefined;

  const status = h('p', { class: 'status', attrs: { role: 'status' } });
  const say = (text: string) => {
    status.textContent = text;
  };

  const render = () => {
    const theme = resolveTheme(state.view.theme, systemPrefersDark());
    const labels = createLabels(report, state.hideNames ? maskSource() : undefined);
    const current = buildViewContext(report, state.view, labels, theme);
    context = current;
    document.documentElement.dataset.theme = theme;

    keepFocus(root, () => {
      header.replaceChildren(...renderHeaderContent(buildHeader(current)));
      controls.sync(state, labels);

      for (const panel of recapFrames) {
        panel.render(current);
      }

      const empty = getEmptyState(current);
      emptySlot.replaceChildren(
        ...(empty
          ? [
              renderEmptyState(empty, {
                resetFilters: () => {
                  update(clearFilters);
                },
                resetView: () => {
                  update((value) => resetView(value, report));
                },
              }),
            ]
          : []),
      );
      data.hidden = empty !== undefined;

      if (empty) {
        return;
      }

      summary.replaceChildren(renderSummary(buildSummary(current)));

      for (const frame of [...chartFrames, ...sectionFrames]) {
        frame.render(current);
      }

      tableSlot.replaceChildren(...renderTable(buildTable(current, state.page), tableActions));
    });
  };

  const update: Update = (change) => {
    const next = change(state);

    // A refused change still re-renders, so an input shows the state again, not what was typed.
    if (next !== state) {
      state = next;
      writeHash(encodeViewState(state.view, report));
    }

    render();
  };

  const tableActions = {
    sort: (key: Parameters<typeof nextSort>[1]) => {
      update((value) => withView(value, { sort: nextSort(value.view.sort, key) }));
    },
    drill: (project: number | null) => {
      const from = state.view.drill;
      update((value) => withView(value, { drill: project }));
      focusKey(root, project === null ? `drill-${from ?? ''}` : 'drill-back');
    },
    page: (page: number) => {
      update((value) => ({ ...value, page }));
    },
  };

  const chartFrames = SHARE_CHARTS.map((chart) => {
    const svgOf = () => frame.body.querySelector('svg');
    const withSvg = (action: (svg: SVGSVGElement, theme: 'light' | 'dark') => void) => () => {
      const svg = svgOf();

      if (!svg || !context) {
        say(`${chart.title} has nothing to export in this view.`);
        return;
      }

      // The theme is read at the click, so a theme switch mid-export cannot mislabel the file.
      action(svg, context.theme);
    };
    const frame = renderChartFrame(chart.id, chart.title, {
      png: withSvg((svg, theme) => {
        const fileName = getExportFileName(pristine.fileBaseName, chart.id, theme, 'png');
        renderPng(svg, frame.element)
          .then((blob) => {
            download(blob, fileName);
            say(`Downloaded ${fileName}`);
          })
          .catch((error: unknown) => {
            say(`Could not create the PNG: ${errorMessage(error)}`);
          });
      }),
      svg: withSvg((svg, theme) => {
        const fileName = getExportFileName(pristine.fileBaseName, chart.id, theme, 'svg');
        download(new Blob([exportSvg(svg, frame.element)], { type: 'image/svg+xml' }), fileName);
        say(`Downloaded ${fileName}`);
      }),
      copy: canCopyImage()
        ? withSvg((svg) => {
            copyPng(() => renderPng(svg, frame.element))
              .then(() => {
                say(`Copied ${chart.title} to the clipboard`);
              })
              .catch((error: unknown) => {
                say(`Could not copy the image: ${errorMessage(error)}. Use PNG instead.`);
              });
          })
        : undefined,
    });

    return {
      element: frame.element,
      render: (current: ShareViewContext) => {
        chart.render(frame.body, current);
      },
    };
  });

  const panelFrames = (list: typeof panels.recap) =>
    list.map((panel) => {
      const frame = renderPanelFrame(panel.id, panel.title);
      return {
        element: frame.element,
        render: (current: ShareViewContext) => {
          panel.render(frame.body, current);
        },
      };
    });
  const recapFrames = panelFrames(panels.recap);
  const sectionFrames = panelFrames(panels.section);

  const saveView = () => {
    const html = renderShareDocument({
      ...pristine,
      viewStateJson: serializeSavedView(encodeViewState(state.view, report)),
    });
    const fileName = `${pristine.fileBaseName}-view.html`;
    download(new Blob([html], { type: 'text/html' }), fileName);
    say(
      state.hideNames
        ? `Saved ${fileName}. It still holds the real names: Hide names only changes the screen.`
        : `Saved ${fileName}. It opens on this view.`,
    );
  };

  const header = h('div', { class: 'masthead-text' });
  const saveButton = h('button', {
    class: 'button',
    attrs: { type: 'button', 'data-focus': 'save-view' },
    text: 'Save this view',
  });
  saveButton.addEventListener('click', saveView);
  const controls = createControls(report, update);
  const emptySlot = h('div', { class: 'empty-slot' });
  const summary = h('section', { class: 'summary-section', attrs: { 'aria-label': 'Totals' } });
  const tableSlot = h('section', {
    class: 'table-section',
    attrs: { 'aria-labelledby': 'table-heading' },
  });
  const data = h('div', { class: 'data' }, [
    summary,
    chartFrames.length > 0 &&
      h(
        'div',
        { class: 'charts' },
        chartFrames.map((frame) => frame.element),
      ),
    ...sectionFrames.map((frame) => frame.element),
    tableSlot,
  ]);
  const main = h('main', { class: 'content', attrs: { id: 'main', tabindex: -1 } }, [
    emptySlot,
    data,
  ]);
  const skip = h('button', { class: 'skip', attrs: { type: 'button' }, text: 'Skip to the data' });
  skip.addEventListener('click', () => {
    main.focus();
  });

  root.replaceChildren(
    h('div', { class: 'page' }, [
      skip,
      h('header', { class: 'masthead' }, [
        header,
        h('div', { class: 'masthead-actions' }, [saveButton, status]),
      ]),
      ...recapFrames.map((frame) => frame.element),
      h('div', { class: 'toolbar' }, [controls.element]),
      main,
      h('footer', { class: 'colophon' }, [
        h('p', {
          text: 'Made with llm-usage-metrics. This file is self-contained: it loads nothing from the network.',
        }),
      ]),
    ]),
  );

  addEventListener('hashchange', () => {
    state = { ...state, view: resolveInitialView(readHash(), pristine.savedHash, report), page: 0 };
    render();
  });
  onSystemSchemeChange(() => {
    if (state.view.theme === 'auto') {
      render();
    }
  });

  render();
}
