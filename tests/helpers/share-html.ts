import { createHash } from 'node:crypto';

import type { ShareReportData } from '../../src/share-report/types.js';

export function cspHash(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

export function between(html: string, open: string, close: string): string {
  const start = html.indexOf(open);
  const end = html.indexOf(close, start + open.length);

  if (start < 0 || end < 0) {
    throw new Error(`Missing ${open}`);
  }

  return html.slice(start + open.length, end);
}

/** An attribute value as the browser reads it. */
function decodeAttribute(value: string): string {
  return value
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** What the browser reads back: the CSP, the one style, the one executable script, the JSON blocks. */
export function readParts(html: string) {
  return {
    csp: decodeAttribute(
      between(html, '<meta http-equiv="Content-Security-Policy" content="', '">'),
    ),
    style: between(html, '<style>', '</style>'),
    script: between(html, '\n<script>', '</script>'),
    payload: between(html, '<script type="application/json" id="report-data">', '</script>'),
    title: between(html, '<title>', '</title>'),
  };
}

/** The markup with the executable script's text left out: what the HTML parser sees as tags. */
export function markupOnly(html: string): string {
  const parts = readParts(html);
  return html.replace(parts.script, '');
}

export function cspSource(csp: string, directive: string): string {
  const entry = csp.split('; ').find((part) => part.startsWith(`${directive} `));
  return (entry ?? '').slice(directive.length + 1);
}

/** The payload embedded in a written share report, as the page reads it. */
export function readSharePayload(html: string): {
  schemaVersion: number;
  report: string;
  data: ShareReportData;
} {
  return JSON.parse(readParts(html).payload) as {
    schemaVersion: number;
    report: string;
    data: ShareReportData;
  };
}
