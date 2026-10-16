// The page's entry: reads the embedded payload and starts the shell, or explains why it cannot.
// Runs once, at the end of the body, so every element it reads is already parsed.

import { decodeShareReport, parseReportData, REPORT_DATA_ELEMENT_ID } from '../core/index.js';
import { APP_ELEMENT_ID, parseSavedView, VIEW_STATE_ELEMENT_ID } from './export/share-document.js';
import { startApp } from './shell/app.js';
import { renderFailure } from './shell/render.js';

// The pristine parts "Save this view" rebuilds the file from, read before anything changes.
const script = document.currentScript?.textContent ?? '';
const style = document.querySelector('head > style')?.textContent ?? '';
const contentSecurityPolicy =
  document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ??
  '';
const payloadJson = document.getElementById(REPORT_DATA_ELEMENT_ID)?.textContent ?? '';
const savedHash = parseSavedView(document.getElementById(VIEW_STATE_ELEMENT_ID)?.textContent);
const root = document.getElementById(APP_ELEMENT_ID);
const decoded = decodeShareReport(parseReportData(payloadJson));

if (root) {
  if (decoded.ok) {
    startApp(root, decoded.report, {
      title: document.title,
      fileBaseName: document.body.dataset.fileBaseName ?? 'llm-usage-report',
      contentSecurityPolicy,
      style,
      script,
      payloadJson,
      savedHash,
    });
  } else {
    root.replaceChildren(renderFailure(decoded.error));
  }
}

document.documentElement.dataset.reportReady = String(decoded.ok);
