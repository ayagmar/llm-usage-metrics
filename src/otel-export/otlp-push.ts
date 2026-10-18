import { setTimeout as sleepTimer } from 'node:timers/promises';

import { asRecord } from '@ayagmar/agent-sessions/internal';

import { getErrorReason } from '../utils/get-error-reason.js';
import type { OtlpMetricsData } from './otlp-metrics.js';
import type { OtlpTracesData } from './otlp-traces.js';

/**
 * Opt-in OTLP/HTTP JSON push of the lines `events --format otlp-traces|otlp-metrics`
 * prints. Each request merges whole lines, so its resources are byte-for-byte the ones a
 * file export holds; nothing is re-encoded.
 */

/** A request body stays under this size unless one line alone is larger. */
export const OTLP_MAX_BATCH_BYTES = 4 * 1024 * 1024;
/** Per request; the OTel exporter default (`OTEL_EXPORTER_OTLP_TIMEOUT`). */
export const OTLP_TIMEOUT_MS = 10_000;
/** A longer `Retry-After` fails the push instead of waiting. */
const MAX_RETRY_AFTER_MS = 60_000;
const ERROR_DETAIL_MAX_CHARS = 200;

export const OTLP_HEADERS_ENV_VAR = 'OTEL_EXPORTER_OTLP_HEADERS';

export type OtlpPushSignal =
  | { kind: 'traces'; lines: readonly OtlpTracesData[] }
  | { kind: 'metrics'; lines: readonly OtlpMetricsData[] };

export type OtlpPushDeps = {
  fetchImpl?: typeof fetch;
  otlpTimeoutMs?: number;
  otlpMaxBatchBytes?: number;
};

export type OtlpPushResult = {
  url: string;
  items: number;
  unit: 'spans' | 'points';
  batches: number;
  rejected: number;
  rejectedMessage?: string;
};

type Batch = { body: string; items: number };

/** Validates `--otlp-endpoint`: an http or https URL without credentials. */
export function parseOtlpEndpoint(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `--otlp-endpoint must be an http: or https: URL, for example http://127.0.0.1:4318`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `--otlp-endpoint must use http: or https:, got ${url.protocol} (for example http://127.0.0.1:4318)`,
    );
  }

  if (url.username || url.password) {
    throw new Error(
      `--otlp-endpoint must not carry credentials; pass them in ${OTLP_HEADERS_ENV_VAR}, for example Authorization=Bearer%20<token>`,
    );
  }

  return url;
}

// RFC 9110 token characters, the only ones a header name may use.
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^`|~\w]+$/u;

/**
 * Parses `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values percent-decoded). Errors name
 * the entry or key, never a value: values are secrets.
 */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};

  if (value === undefined || value.trim() === '') {
    return headers;
  }

  for (const [index, entry] of value.split(',').entries()) {
    if (entry.trim() === '') {
      continue;
    }

    const separator = entry.indexOf('=');
    const key = (separator === -1 ? entry : entry.slice(0, separator)).trim();

    if (separator === -1 || !HEADER_NAME_PATTERN.test(key)) {
      throw new Error(
        `${OTLP_HEADERS_ENV_VAR}: entry ${index + 1} is not key=value with a valid header name`,
      );
    }

    let decoded: string;

    try {
      decoded = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      throw new Error(`${OTLP_HEADERS_ENV_VAR}: the value of ${key} is not valid percent-encoding`);
    }

    // fetch would reject these and quote the value in its error.
    if (/[\0\r\n]/u.test(decoded)) {
      throw new Error(`${OTLP_HEADERS_ENV_VAR}: the value of ${key} has a line break or NUL`);
    }

    headers[key] = decoded;
  }

  return headers;
}

function signalUrl(endpoint: URL, kind: OtlpPushSignal['kind']): string {
  const url = new URL(endpoint);
  const base = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${base}/v1/${kind}`;
  return url.toString();
}

function countItems(signal: OtlpPushSignal, index: number): number {
  if (signal.kind === 'traces') {
    return signal.lines[index].resourceSpans
      .flatMap((resource) => resource.scopeSpans)
      .reduce((sum, scope) => sum + scope.spans.length, 0);
  }

  return signal.lines[index].resourceMetrics
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .reduce((sum, metric) => sum + metric.sum.dataPoints.length, 0);
}

function resourcesOf(signal: OtlpPushSignal, index: number): readonly unknown[] {
  return signal.kind === 'traces'
    ? signal.lines[index].resourceSpans
    : signal.lines[index].resourceMetrics;
}

function toBody(signal: OtlpPushSignal, resources: unknown[]): string {
  return JSON.stringify(
    signal.kind === 'traces' ? { resourceSpans: resources } : { resourceMetrics: resources },
  );
}

/** Whole lines per batch, in export order, each batch under `maxBytes` when it can be. */
function buildBatches(signal: OtlpPushSignal, maxBytes: number): Batch[] {
  const batches: Batch[] = [];
  let resources: unknown[] = [];
  let items = 0;
  let bytes = 0;

  const flush = () => {
    if (resources.length > 0) {
      batches.push({ body: toBody(signal, resources), items });
    }

    resources = [];
    items = 0;
    bytes = 0;
  };

  for (let index = 0; index < signal.lines.length; index += 1) {
    const lineBytes = Buffer.byteLength(JSON.stringify(signal.lines[index]));

    if (bytes > 0 && bytes + lineBytes > maxBytes) {
      flush();
    }

    resources.push(...resourcesOf(signal, index));
    items += countItems(signal, index);
    bytes += lineBytes;
  }

  flush();
  return batches;
}

/** `Retry-After` as delay-seconds or an HTTP date, in milliseconds. */
function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }

  const trimmed = value.trim();

  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The response body as text and, when it is a JSON object, as a record. */
async function readBody(
  response: Response,
): Promise<{ text: string; json: Record<string, unknown> | undefined }> {
  const text = await response.text().catch(() => '');

  try {
    return { text, json: asRecord(JSON.parse(text)) };
  } catch {
    return { text, json: undefined };
  }
}

/** The OTLP `Status.message` of an error response, else its text, on one short line. */
async function readErrorDetail(response: Response): Promise<string> {
  const { text, json } = await readBody(response);
  const detail = typeof json?.message === 'string' ? json.message : text;
  const oneLine = detail.replaceAll(/\s+/gu, ' ').trim();
  return oneLine.length > ERROR_DETAIL_MAX_CHARS
    ? `${oneLine.slice(0, ERROR_DETAIL_MAX_CHARS)}…`
    : oneLine;
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) {
    return `check the credentials in ${OTLP_HEADERS_ENV_VAR}`;
  }

  if (status === 404) {
    return 'pass the receiver base URL; /v1/traces or /v1/metrics is appended';
  }

  if (status === 413) {
    return 'the receiver limits request size; raise its limit or export a shorter range';
  }

  if (status >= 500) {
    return 'the receiver failed; try again later';
  }

  return 'the receiver rejected the payload';
}

type PartialSuccess = { rejected: number; message?: string };

/** OTLP `partialSuccess`: items the receiver accepted the request for but dropped. */
async function readPartialSuccess(
  response: Response,
  kind: OtlpPushSignal['kind'],
): Promise<PartialSuccess> {
  const partial = asRecord((await readBody(response)).json?.partialSuccess);
  const rejected = Number(
    partial?.[kind === 'traces' ? 'rejectedSpans' : 'rejectedDataPoints'] ?? 0,
  );
  const message =
    typeof partial?.errorMessage === 'string' && partial.errorMessage !== ''
      ? partial.errorMessage
      : undefined;

  return { rejected: Number.isFinite(rejected) ? rejected : 0, message };
}

class OtlpPushError extends Error {}

async function postBatch(
  url: string,
  batch: Batch,
  headers: Record<string, string>,
  deps: Required<OtlpPushDeps>,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;

    try {
      response = await deps.fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: batch.body,
        signal: AbortSignal.timeout(deps.otlpTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new OtlpPushError(
          `no response within ${deps.otlpTimeoutMs / 1000} s; check that a receiver listens there`,
        );
      }

      const cause =
        error instanceof Error && error.cause !== undefined
          ? `: ${getErrorReason(error.cause)}`
          : '';
      throw new OtlpPushError(
        `${getErrorReason(error)}${cause}; check the endpoint URL and that a receiver listens there`,
      );
    }

    if (response.ok) {
      return response;
    }

    const retryAfterMs =
      response.status === 429 || response.status === 503
        ? parseRetryAfterMs(response.headers.get('retry-after'), Date.now())
        : undefined;

    if (attempt === 0 && retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await response.body?.cancel();
      await sleepTimer(retryAfterMs);
      continue;
    }

    const detail = await readErrorDetail(response);
    const statusText = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw new OtlpPushError(
      `${statusText}${detail ? ` (${detail})` : ''}; ${statusHint(response.status)}`,
    );
  }
}

/**
 * POSTs the export lines to `<endpoint>/v1/traces` or `/v1/metrics`, batched and in order.
 * Stops at the first failed request; the error says how much was sent before it.
 */
export async function pushOtlp(
  endpoint: URL,
  signal: OtlpPushSignal,
  headers: Record<string, string>,
  deps: OtlpPushDeps = {},
): Promise<OtlpPushResult> {
  const resolvedDeps: Required<OtlpPushDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    otlpTimeoutMs: deps.otlpTimeoutMs ?? OTLP_TIMEOUT_MS,
    otlpMaxBatchBytes: deps.otlpMaxBatchBytes ?? OTLP_MAX_BATCH_BYTES,
  };
  const url = signalUrl(endpoint, signal.kind);
  const unit = signal.kind === 'traces' ? 'spans' : 'points';
  const batches = buildBatches(signal, resolvedDeps.otlpMaxBatchBytes);
  const result: OtlpPushResult = { url, items: 0, unit, batches: 0, rejected: 0 };

  for (const batch of batches) {
    let response: Response;

    try {
      response = await postBatch(url, batch, headers, resolvedDeps);
    } catch (error) {
      if (!(error instanceof OtlpPushError)) {
        throw error;
      }

      throw new Error(
        `OTLP push to ${url} failed after ${result.batches} of ${batches.length} batches (${result.items} ${unit} sent): ${error.message}`,
        { cause: error },
      );
    }

    const partial = await readPartialSuccess(response, signal.kind);
    result.items += batch.items;
    result.batches += 1;
    result.rejected += partial.rejected;
    result.rejectedMessage ??= partial.message;
  }

  return result;
}

/** The one stderr line a push prints. */
export function formatOtlpPushSummary(result: OtlpPushResult): string {
  const batches = `${result.batches} ${result.batches === 1 ? 'batch' : 'batches'}`;
  const rejected =
    result.rejected > 0
      ? `; the receiver rejected ${result.rejected}${result.rejectedMessage ? ` (${result.rejectedMessage})` : ''}`
      : '';
  return `Pushed ${result.items} ${result.unit} in ${batches} to ${result.url}${rejected}`;
}
