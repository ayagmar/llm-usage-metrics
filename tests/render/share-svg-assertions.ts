import { expect } from 'vitest';

import {
  shareThemes,
  type ShareTheme,
  type ShareThemeName,
} from '../../src/render/share-svg-theme.js';

const THEME_NAMES: readonly ShareThemeName[] = ['dark', 'light'];
const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39);/gu;
const ATTRIBUTE_PATTERN = /\s([\w:-]+)="([^"<]*)"/gu;
const TAG_NAME_PATTERN = /^[a-zA-Z][\w:-]*/u;
// eslint-disable-next-line no-control-regex -- XML 1.0 forbids these characters
const XML_INVALID_CHARACTER = /[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;

/** Hostile text that must come out escaped: markup, an ampersand, and both quotes. */
export const HOSTILE_TEXT = `<script>alert("x")</script> & 'q'`;

function expectEscapedText(text: string, context: string): void {
  const withoutEntities = text.replace(ENTITY_PATTERN, '');
  expect(withoutEntities, `raw & in ${context}`).not.toContain('&');
  expect(withoutEntities, `raw < in ${context}`).not.toContain('<');
  expect(text, `XML-forbidden character in ${context}`).not.toMatch(XML_INVALID_CHARACTER);
}

/**
 * Minimal XML well-formedness check: balanced tags, quoted attributes, and no
 * unescaped `<` or `&` in text or attribute values. Enough to catch a broken
 * escape without an XML parser dependency.
 */
export function expectWellFormedSvg(svg: string): void {
  const stack: string[] = [];
  let position = 0;

  while (position < svg.length) {
    const tagStart = svg.indexOf('<', position);

    if (tagStart === -1) {
      expectEscapedText(svg.slice(position), 'trailing text');
      break;
    }

    expectEscapedText(svg.slice(position, tagStart), `text before offset ${tagStart}`);
    const tagEnd = svg.indexOf('>', tagStart);
    expect(tagEnd, `unclosed tag at offset ${tagStart}`).toBeGreaterThan(tagStart);
    const tag = svg.slice(tagStart + 1, tagEnd);
    position = tagEnd + 1;

    if (tag.startsWith('/')) {
      expect(stack.pop(), `mismatched closing tag </${tag.slice(1)}>`).toBe(tag.slice(1));
      continue;
    }

    const name = TAG_NAME_PATTERN.exec(tag)?.[0];
    expect(name, `invalid tag <${tag}>`).toBeDefined();

    for (const [, attribute, value] of tag.matchAll(ATTRIBUTE_PATTERN)) {
      expectEscapedText(value, `attribute ${attribute} of <${name}>`);
    }

    const rest = tag
      .slice(name?.length ?? 0)
      .replace(ATTRIBUTE_PATTERN, '')
      .trim();
    expect(['', '/'], `stray content in <${tag}>`).toContain(rest);

    if (rest !== '/') {
      stack.push(name ?? '');
    }
  }

  expect(stack, 'unclosed elements').toEqual([]);
}

/** Every share card: fixed 1200x630 size, the theme's background, and well-formed XML. */
export function expectShareCard(svg: string, theme: ShareTheme): void {
  expect(svg).toMatch(/^<svg [^>]*width="1200" height="630" viewBox="0 0 1200 630"/u);
  expect(svg).toContain(`data-theme="${theme.name}"`);
  expect(svg).toContain(`fill="${theme.bg}"`);
  expectWellFormedSvg(svg);
}

/** Renders a card in both themes and checks the shared contract on each. */
export function renderInBothThemes(render: (theme: ShareTheme) => string): string[] {
  return THEME_NAMES.map((name) => {
    const svg = render(shareThemes[name]);
    expectShareCard(svg, shareThemes[name]);
    return svg;
  });
}
