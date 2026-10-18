// The share report's HTML document. The CLI writes it from the generated bundle, and "Save
// this view" rebuilds it in the browser from the same parts, so both go through this one
// template. Pure (no DOM), so the CLI can use it too.

import type { ShareCommand, ShareReportMeta } from '../../../types.js';
import { REPORT_DATA_ELEMENT_ID } from '../../core/decode.js';

/** The id of the `<script type="application/json">` that holds a saved view. */
export const VIEW_STATE_ELEMENT_ID = 'view-state';

/** The id of the element the page renders into. */
export const APP_ELEMENT_ID = 'app';

export type ShareDocumentParts = {
  title: string;
  /** File name without extension; exports and saved views are named after it. */
  fileBaseName: string;
  contentSecurityPolicy: string;
  /** The exact style text the CSP hash covers. */
  style: string;
  /** The exact script text the CSP hash covers. */
  script: string;
  /** The payload JSON, already passed through {@link escapeJsonForScript}. */
  payloadJson: string;
  /** A saved view's JSON, already escaped; absent in a file the CLI writes. */
  viewStateJson?: string;
};

const COMMAND_TITLES: Record<ShareCommand, string> = {
  daily: 'Daily usage',
  weekly: 'Weekly usage',
  monthly: 'Monthly usage',
  summary: 'Usage summary',
  compare: 'Usage comparison',
  trends: 'Usage trends',
  efficiency: 'Efficiency',
  optimize: 'Model costs',
  wrapped: 'Wrapped',
};

/** The page and document title: the command's report, and wrapped's year. */
export function getReportTitle(meta: Pick<ShareReportMeta, 'command' | 'window'>): string {
  const title = COMMAND_TITLES[meta.command];
  const year = (meta.window.until ?? meta.window.since)?.slice(0, 4);

  return meta.command === 'wrapped' && year !== undefined ? `${title} ${year}` : title;
}

/**
 * Makes JSON safe inside a `<script>` element: `<` cannot start `</script` or `<!--`, and the
 * line and paragraph separators are escaped as older parsers require. Each of these characters
 * can only occur inside a JSON string, where the escape means the same character.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for an HTML element or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * The page's policy: nothing loads from anywhere, the one script and the one style run only
 * when their bytes match the hashes, and PNG export may draw from a blob URL.
 */
export function buildContentSecurityPolicy(scriptHash: string, styleHash: string): string {
  return [
    "default-src 'none'",
    `script-src '${scriptHash}'`,
    `style-src '${styleHash}'`,
    'img-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** The view a saved file opens on: the same hash a link to that view would carry. */
export function serializeSavedView(hash: string): string {
  return escapeJsonForScript(JSON.stringify({ hash }));
}

/** The hash of a saved view, or undefined when the element is missing or malformed. */
export function parseSavedView(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(text);

    return typeof value === 'object' &&
      value !== null &&
      'hash' in value &&
      typeof value.hash === 'string'
      ? value.hash
      : undefined;
  } catch {
    return undefined;
  }
}

// The client bundles this template for "Save this view", and its inline script must not
// contain `</style` or `</script` (they would end the element), so closing tags are put
// together at run time; a minifier could fold a string concatenation back.
const END_TAG = String.fromCharCode(60, 47);

/** The whole file. The CSP meta comes before the style and script it governs. */
export function renderShareDocument(parts: ShareDocumentParts): string {
  const viewState =
    parts.viewStateJson === undefined
      ? ''
      : `<script type="application/json" id="${VIEW_STATE_ELEMENT_ID}">${parts.viewStateJson}${END_TAG}script>\n`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(parts.contentSecurityPolicy)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(parts.title)}${END_TAG}title>
<style>${parts.style}${END_TAG}style>
</head>
<body data-file-base-name="${escapeHtml(parts.fileBaseName)}">
<noscript><p class="noscript">This report draws its charts and tables with JavaScript. Open it in a browser with scripts enabled.</p></noscript>
<div id="${APP_ELEMENT_ID}"></div>
<script type="application/json" id="${REPORT_DATA_ELEMENT_ID}">${parts.payloadJson}${END_TAG}script>
${viewState}<script>${parts.script}${END_TAG}script>
</body>
</html>
`;
}
