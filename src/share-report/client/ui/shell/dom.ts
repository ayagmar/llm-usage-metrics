// Element builders for the page and its charts. Text goes in as text nodes, never markup, and
// no `style` attribute is ever set: the CSP would block it.

import { SVG_NAMESPACE } from '../export/svg-export.js';

type Child = Node | string | false | null | undefined;

export type ElementProps = {
  class?: string;
  /** Attributes; `false` and undefined leave one out. */
  attrs?: Record<string, string | number | boolean | undefined>;
  text?: string;
};

function applyProps(element: Element, props: ElementProps, children: readonly Child[]): void {
  if (props.class) {
    element.setAttribute('class', props.class);
  }

  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (name === 'style') {
      throw new Error('The share report sets no style attribute (CSP)');
    }

    if (value !== undefined && value !== false) {
      element.setAttribute(name, value === true ? '' : String(value));
    }
  }

  if (props.text !== undefined) {
    element.textContent = props.text;
  }

  for (const child of children) {
    if (child !== false && child !== null && child !== undefined) {
      element.append(child);
    }
  }
}

/** An HTML element with props and children. */
export function h<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  props: ElementProps = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  applyProps(element, props, children);
  return element;
}

/** An SVG element with props and children, for charts. */
export function s<Tag extends keyof SVGElementTagNameMap>(
  tag: Tag,
  props: ElementProps = {},
  children: readonly Child[] = [],
): SVGElementTagNameMap[Tag] {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  applyProps(element, props, children);
  return element;
}

/** Re-focuses the element with the same `data-focus` key when a re-render replaced it. */
export function keepFocus(root: HTMLElement, render: () => void): void {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && root.contains(active) ? active.dataset.focus : undefined;

  render();

  if (key !== undefined && active?.isConnected === false) {
    const next = root.querySelector(`[data-focus="${CSS.escape(key)}"]`);

    if (next instanceof HTMLElement) {
      next.focus();
    }
  }
}
