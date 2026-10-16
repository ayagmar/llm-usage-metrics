/** The id of the `<script type="application/json">` element that holds the report payload. */
export const REPORT_DATA_ELEMENT_ID = 'report-data';

/** Parses the embedded payload text; returns undefined when it is missing or not JSON. */
export function parseReportData(text: string | null | undefined): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
