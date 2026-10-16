import type { ShareReportData } from '../../src/share-report/types.js';

const PAYLOAD_OPEN = '<script type="application/json" id="report-data">';

/** The payload embedded in a written share report, as the page reads it. */
export function readSharePayload(html: string): {
  schemaVersion: number;
  report: string;
  data: ShareReportData;
} {
  const start = html.indexOf(PAYLOAD_OPEN);
  const end = html.indexOf('</script>', start);

  if (start < 0 || end < 0) {
    throw new Error('The share report holds no payload');
  }

  return JSON.parse(html.slice(start + PAYLOAD_OPEN.length, end)) as {
    schemaVersion: number;
    report: string;
    data: ShareReportData;
  };
}
