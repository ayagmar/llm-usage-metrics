import { listShareSizeWarnings } from '../share-report/build-share-payload.js';
import { renderShareHtml } from '../share-report/render-share-html.js';
import type {
  ShareDateRange,
  ShareEmbeddedEnvelope,
  ShareGranularity,
} from '../share-report/types.js';
import { logger } from '../utils/logger.js';
import type { ReportGranularity } from '../utils/time-buckets.js';
import { buildShareReport, type ShareReportRequest } from './build-share-report-data.js';
import type { ShareArtifact } from './share-artifact.js';
import type { BuildUsageDataDeps } from './usage-data-contracts.js';

export type ShareReportArtifactRequest = ShareReportRequest & {
  /** The `.html` file name without extension, e.g. `usage-daily-share`. */
  fileBaseName: string;
  /** Names the report in the stderr lines, e.g. `usage`. */
  logLabel: string;
};

const SHARE_GRANULARITIES = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
} as const satisfies Record<ReportGranularity, ShareGranularity>;

export function toShareGranularity(granularity: ReportGranularity): ShareGranularity {
  return SHARE_GRANULARITIES[granularity];
}

/** A window from optional `YYYY-MM-DD` ends; a missing end stays open. */
export function toShareDateRange(
  since: string | undefined,
  until: string | undefined,
): ShareDateRange {
  return { since: since ?? null, until: until ?? null };
}

type ShareEnvelopeInput = Pick<ShareEmbeddedEnvelope, 'report' | 'data'>;

function isEnvelopeInput(value: unknown): value is ShareEnvelopeInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'report' in value &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null
  );
}

/** A command's `--json` output as the envelope its share file embeds, exactly as written. */
export function parseReportJsonEnvelope(json: string): ShareEnvelopeInput {
  const parsed: unknown = JSON.parse(json);

  if (!isEnvelopeInput(parsed)) {
    throw new Error('A share report can only embed a report JSON envelope');
  }

  return { report: parsed.report, data: parsed.data };
}

/** Builds the payload of a `--share` run and the one HTML file that holds it. */
export async function buildShareReportArtifact(
  request: ShareReportArtifactRequest,
  deps: BuildUsageDataDeps,
): Promise<ShareArtifact> {
  const { fileBaseName, logLabel, ...shareRequest } = request;
  const { data, scrubLog } = await buildShareReport(shareRequest, deps);

  return {
    fileName: `${fileBaseName}.html`,
    logLabel,
    scrubLog,
    // Warned as the file is written, after the command's own diagnostics.
    render: () => {
      const html = renderShareHtml({ data, fileBaseName });
      const sizeWarnings = listShareSizeWarnings({
        hourlyFrom: data.meta.hourlyFrom,
        htmlBytes: Buffer.byteLength(html),
      });

      for (const warning of sizeWarnings) {
        logger.warn(warning);
      }

      return html;
    },
  };
}
