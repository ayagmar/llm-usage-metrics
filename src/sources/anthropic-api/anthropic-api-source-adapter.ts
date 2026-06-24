import { createUsageEvent } from '../../domain/usage-event.js';
import type { UsageEvent } from '../../domain/usage-event.js';
import { asRecord } from '../../utils/as-record.js';
import { incrementSkippedReason, toParseDiagnostics } from '../parse-diagnostics.js';
import { asTrimmedText, normalizeTimestampCandidate, toNumberLike } from '../parsing-utils.js';
import type { SourceAdapter, SourceParseFileDiagnostics } from '../source-adapter.js';
import { normalizeNonNegativeInteger } from '../../domain/normalization.js';

const defaultAnthropicAdminKeyEnv = 'ANTHROPIC_ADMIN_KEY';
const defaultAnthropicUsageApiUrl =
  'https://api.anthropic.com/v1/organizations/usage_report/messages';
const anthropicVersion = '2023-06-01';
const oneDayMs = 24 * 60 * 60 * 1000;
const maxDailyWindowDays = 31;

type FetchLike = typeof fetch;

type AnthropicApiUsageWindow = {
  startingAt: string;
  endingAt: string;
};

export type AnthropicApiSourceAdapterOptions = {
  adminKeyEnv?: string;
  usageApiUrl?: string;
  since?: string;
  until?: string;
  now?: () => Date;
  fetchImpl?: FetchLike;
};

function normalizeAdminKeyEnv(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized !== undefined && normalized.length > 0
    ? normalized
    : defaultAnthropicAdminKeyEnv;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * oneDayMs);
}

function resolveDateWindow(options: { since?: string; until?: string; now: () => Date }): {
  since: string;
  until: string;
} {
  if (options.since && options.until) {
    return { since: options.since, until: options.until };
  }

  if (options.since) {
    return {
      since: options.since,
      until: toIsoDate(addDays(parseDateOnly(options.since), maxDailyWindowDays - 1)),
    };
  }

  if (options.until) {
    return {
      since: toIsoDate(addDays(parseDateOnly(options.until), -(maxDailyWindowDays - 1))),
      until: options.until,
    };
  }

  const today = parseDateOnly(toIsoDate(options.now()));
  return {
    since: toIsoDate(addDays(today, -(maxDailyWindowDays - 1))),
    until: toIsoDate(today),
  };
}

function createWindows(since: string, until: string): AnthropicApiUsageWindow[] {
  const windows: AnthropicApiUsageWindow[] = [];
  let cursor = parseDateOnly(since);
  const endDate = parseDateOnly(until);

  while (cursor.getTime() <= endDate.getTime()) {
    const windowEnd = new Date(
      Math.min(addDays(cursor, maxDailyWindowDays - 1).getTime(), endDate.getTime()),
    );

    windows.push({
      startingAt: `${toIsoDate(cursor)}T00:00:00Z`,
      endingAt: `${toIsoDate(addDays(windowEnd, 1))}T00:00:00Z`,
    });
    cursor = addDays(windowEnd, 1);
  }

  return windows;
}

function appendRepeatedParam(url: URL, key: string, value: string): void {
  url.searchParams.append(key, value);
}

function buildUsageUrl(
  baseUrl: string,
  usageWindow: AnthropicApiUsageWindow,
  page: string | undefined,
): string {
  const url = new URL(baseUrl);
  url.searchParams.set('starting_at', usageWindow.startingAt);
  url.searchParams.set('ending_at', usageWindow.endingAt);
  url.searchParams.set('bucket_width', '1d');
  appendRepeatedParam(url, 'group_by[]', 'model');

  if (page) {
    url.searchParams.set('page', page);
  }

  return url.toString();
}

function readBucketArray(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.usage_buckets)) {
    return payload.usage_buckets;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.buckets)) {
    return payload.buckets;
  }

  return [];
}

function readBucketResults(bucket: Record<string, unknown>): unknown[] {
  if (Array.isArray(bucket.results)) {
    return bucket.results;
  }

  if (Array.isArray(bucket.items)) {
    return bucket.items;
  }

  if (Array.isArray(bucket.models)) {
    return bucket.models;
  }

  return [];
}

function readNextPage(payload: Record<string, unknown>): string | undefined {
  return asTrimmedText(payload.next_page) ?? asTrimmedText(payload.nextPage);
}

function hasMorePages(payload: Record<string, unknown>): boolean {
  return payload.has_more === true || payload.hasMore === true;
}

function resolveBucketTimestamp(bucket: Record<string, unknown>): string | undefined {
  return normalizeTimestampCandidate(
    bucket.starting_at ?? bucket.startingAt ?? bucket.bucket_starting_at ?? bucket.date,
  );
}

function resolveModel(result: Record<string, unknown>): string | undefined {
  return (
    asTrimmedText(result.model) ?? asTrimmedText(result.model_id) ?? asTrimmedText(result.modelId)
  );
}

function resolveTokens(result: Record<string, unknown>):
  | {
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
    }
  | undefined {
  const inputTokens = normalizeNonNegativeInteger(
    toNumberLike(result.input_tokens ?? result.uncached_input_tokens),
  );
  const outputTokens = normalizeNonNegativeInteger(toNumberLike(result.output_tokens));
  const cacheReadTokens = normalizeNonNegativeInteger(toNumberLike(result.cache_read_input_tokens));
  const cacheWriteTokens = normalizeNonNegativeInteger(
    toNumberLike(result.cache_creation_input_tokens),
  );
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  if (totalTokens === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

export class AnthropicApiSourceAdapter implements SourceAdapter {
  public readonly id = 'anthropic-api' as const;
  public readonly capabilities = {
    requiresExplicitSelection: true,
  } as const;

  private readonly adminKeyEnv: string;
  private readonly usageApiUrl: string;
  private readonly since: string | undefined;
  private readonly until: string | undefined;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;

  public constructor(options: AnthropicApiSourceAdapterOptions = {}) {
    this.adminKeyEnv = normalizeAdminKeyEnv(options.adminKeyEnv);
    this.usageApiUrl = options.usageApiUrl ?? defaultAnthropicUsageApiUrl;
    this.since = options.since;
    this.until = options.until;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public discoverFiles(): Promise<string[]> {
    return Promise.resolve([]);
  }

  public async parseFile(): Promise<UsageEvent[]> {
    const { events } = await this.parseSourceWithDiagnostics();
    return events;
  }

  public async parseSourceWithDiagnostics(): Promise<SourceParseFileDiagnostics> {
    const events: UsageEvent[] = [];
    let skippedRows = 0;
    let sourceItemsFound = 0;
    const skippedRowReasons = new Map<string, number>();
    const adminKey = process.env[this.adminKeyEnv]?.trim();

    if (!adminKey) {
      throw new Error(`Anthropic Admin API key is required in ${this.adminKeyEnv}`);
    }

    const dateWindow = resolveDateWindow({
      since: this.since,
      until: this.until,
      now: this.now,
    });

    for (const usageWindow of createWindows(dateWindow.since, dateWindow.until)) {
      let page: string | undefined;

      do {
        const response = await this.fetchImpl(buildUsageUrl(this.usageApiUrl, usageWindow, page), {
          headers: {
            'x-api-key': adminKey,
            'anthropic-version': anthropicVersion,
          },
        });

        if (!response.ok) {
          throw new Error(`Anthropic Admin API request failed with status ${response.status}`);
        }

        const payload = asRecord(await response.json());

        if (!payload) {
          skippedRows++;
          incrementSkippedReason(skippedRowReasons, 'invalid_response');
          break;
        }

        for (const rawBucket of readBucketArray(payload)) {
          const bucket = asRecord(rawBucket);

          if (!bucket) {
            skippedRows++;
            incrementSkippedReason(skippedRowReasons, 'invalid_bucket');
            continue;
          }

          const timestamp = resolveBucketTimestamp(bucket);

          if (!timestamp) {
            skippedRows++;
            incrementSkippedReason(skippedRowReasons, 'invalid_timestamp');
            continue;
          }

          for (const rawResult of readBucketResults(bucket)) {
            sourceItemsFound++;
            const result = asRecord(rawResult);

            if (!result) {
              skippedRows++;
              incrementSkippedReason(skippedRowReasons, 'invalid_result');
              continue;
            }

            const model = resolveModel(result);
            const tokens = resolveTokens(result);

            if (!model || !tokens) {
              skippedRows++;
              incrementSkippedReason(skippedRowReasons, 'no_token_usage');
              continue;
            }

            try {
              events.push(
                createUsageEvent({
                  source: this.id,
                  sessionId: `anthropic-api:${timestamp.slice(0, 10)}:${model}`,
                  timestamp,
                  provider: 'anthropic',
                  model,
                  ...tokens,
                  costMode: 'estimated',
                }),
              );
            } catch {
              skippedRows++;
              incrementSkippedReason(skippedRowReasons, 'event_creation_failed');
            }
          }
        }

        page = hasMorePages(payload) ? readNextPage(payload) : undefined;
      } while (page);
    }

    return {
      ...toParseDiagnostics(events, skippedRows, skippedRowReasons),
      sourceItemsFound,
    };
  }
}

export function getDefaultAnthropicAdminKeyEnv(): string {
  return defaultAnthropicAdminKeyEnv;
}
