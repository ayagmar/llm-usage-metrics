// The interactive share report: one self-contained HTML file holding the payload, the bundled
// client and a CSP that lets only those exact script and style bytes run.

import {
  SHARE_CLIENT_SCRIPT,
  SHARE_CLIENT_SCRIPT_HASH,
  SHARE_CLIENT_STYLE,
  SHARE_CLIENT_STYLE_HASH,
} from './client-bundle.generated.js';
import {
  buildContentSecurityPolicy,
  escapeJsonForScript,
  getReportTitle,
  renderShareDocument,
} from './client/ui/export/share-document.js';
import type { ShareReportData } from './types.js';

export type ShareHtmlOptions = {
  data: ShareReportData;
  /** File name without extension; exports and saved views are named after it. */
  fileBaseName: string;
  /** The document title; the command's report title by default. */
  title?: string;
};

export function renderShareHtml(options: ShareHtmlOptions): string {
  const payload = { schemaVersion: 1, report: 'share', data: options.data };

  return renderShareDocument({
    title: options.title ?? `${getReportTitle(options.data.meta)} · llm-usage-metrics`,
    fileBaseName: options.fileBaseName,
    contentSecurityPolicy: buildContentSecurityPolicy(
      SHARE_CLIENT_SCRIPT_HASH,
      SHARE_CLIENT_STYLE_HASH,
    ),
    style: SHARE_CLIENT_STYLE,
    script: SHARE_CLIENT_SCRIPT,
    payloadJson: escapeJsonForScript(JSON.stringify(payload)),
  });
}
