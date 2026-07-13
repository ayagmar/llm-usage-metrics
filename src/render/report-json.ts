export const REPORT_JSON_SCHEMA_VERSION = 1;

export type ReportJsonName =
  | 'usage'
  | 'session'
  | 'trends'
  | 'compare'
  | 'efficiency'
  | 'optimize'
  | 'wrapped'
  | 'doctor'
  | 'prune';

export function renderReportJson(report: ReportJsonName, data: unknown): string {
  return JSON.stringify({ schemaVersion: REPORT_JSON_SCHEMA_VERSION, report, data }, null, 2);
}
