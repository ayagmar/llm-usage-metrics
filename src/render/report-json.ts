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
  | 'config-show'
  | 'prune'
  | 'projects'
  | 'blocks'
  | 'pricing'
  | 'value'
  | 'share';

/** Envelope fields beside `data`, for payloads (bare arrays) that cannot carry them. */
type ReportJsonEnvelopeFields = {
  /** Rows before --top, when `data` is a list --top may have cut. */
  rowCount?: number;
};

export function renderReportJson(
  report: ReportJsonName,
  data: unknown,
  envelopeFields: ReportJsonEnvelopeFields = {},
): string {
  return JSON.stringify(
    { schemaVersion: REPORT_JSON_SCHEMA_VERSION, report, ...envelopeFields, data },
    null,
    2,
  );
}
