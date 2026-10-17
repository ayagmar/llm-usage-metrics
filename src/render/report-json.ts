const REPORT_JSON_SCHEMA_VERSION = 1;

export type ReportJsonName =
  | 'usage'
  | 'summary'
  | 'session'
  | 'tools'
  | 'context'
  | 'trends'
  | 'compare'
  | 'efficiency'
  | 'optimize'
  | 'wrapped'
  | 'doctor'
  | 'config'
  | 'prune'
  | 'projects'
  | 'blocks'
  | 'pricing'
  | 'value'
  | 'share';

export function renderReportJson(report: ReportJsonName, data: unknown): string {
  return JSON.stringify({ schemaVersion: REPORT_JSON_SCHEMA_VERSION, report, data }, null, 2);
}
