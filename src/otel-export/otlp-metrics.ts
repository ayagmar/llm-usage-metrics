import { usageRecordAttributes, type OtelAttributes } from '@ayagmar/agent-sessions/otel';
import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

import { getLocalDayStartMs } from '../blocks/local-day-start.js';
import { addEventToTotals, createEmptyTotals } from '../aggregate/aggregate-usage.js';
import type { UsageEvent } from '../domain/usage-event.js';
import type { UsageTotals } from '../domain/usage-report-row.js';
import { shiftDateKey } from '../utils/date-key.js';
import { getPeriodKey } from '../utils/time-buckets.js';
import {
  createAgentResource,
  OTLP_SCHEMA_URL,
  OTLP_SCOPE,
  toOtlpAttributes,
  toUnixNanos,
  type OtlpKeyValue,
  type OtlpResource,
  type OtlpScope,
} from './otlp-json.js';

/** OTLP `AggregationTemporality`. */
const AGGREGATION_TEMPORALITY_DELTA = 1;

export type OtlpNumberDataPoint = {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
} & ({ asInt: string } | { asDouble: number });

export type OtlpMetric = {
  name: string;
  description: string;
  unit: string;
  sum: {
    dataPoints: OtlpNumberDataPoint[];
    aggregationTemporality: number;
    isMonotonic: true;
  };
};

/** One OTLP `MetricsData`: one agent's points for one local day. */
export type OtlpMetricsData = {
  resourceMetrics: [
    {
      resource: OtlpResource;
      scopeMetrics: [{ scope: OtlpScope; metrics: OtlpMetric[]; schemaUrl: string }];
    },
  ];
};

export type OtlpMetricsInput = {
  usageEvents: readonly UsageEvent[];
  /** The report timezone; a bucket is one local day in it. */
  timezone: string;
};

type TokenMetric = {
  name: string;
  description: string;
  value: (totals: UsageTotals) => number;
};

// The token counters at the pinned commit (model/gen-ai/token-metrics.yaml). The input
// counter includes cache reads and writes; our `inputTokens` excludes both.
const TOKEN_METRICS: readonly TokenMetric[] = [
  {
    name: 'gen_ai.client.inference.usage.input_tokens',
    description: 'Input tokens, including cache reads and cache writes.',
    value: (totals) => totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
  },
  {
    name: 'gen_ai.client.inference.usage.output_tokens',
    description: 'Output tokens, including reasoning tokens.',
    value: (totals) => totals.outputTokens,
  },
  {
    name: 'gen_ai.client.inference.usage.cache_read.input_tokens',
    description: 'Input tokens read from a provider cache.',
    value: (totals) => totals.cacheReadTokens,
  },
  {
    name: 'gen_ai.client.inference.usage.cache_write.input_tokens',
    description: 'Input tokens written to a provider cache.',
    value: (totals) => totals.cacheWriteTokens,
  },
  {
    name: 'gen_ai.client.inference.usage.reasoning.output_tokens',
    description: 'Output tokens spent on reasoning.',
    value: (totals) => totals.reasoningTokens,
  },
];

const COST_METRIC = {
  name: 'llm_usage.cost_usd',
  description: 'Cost in US dollars, logged or estimated. Unpriced usage adds nothing.',
};

/** The usage of one attribute set in one bucket. */
type PointGroup = {
  /** Provider name, model and machine joined by NUL: sorting keys sorts the tuples. */
  key: string;
  attributes: OtelAttributes;
  totals: UsageTotals;
};

/** One agent's usage in one local day. */
type Bucket = {
  dateKey: string;
  source: string;
  points: Map<string, PointGroup>;
};

function pointAttributes(event: UsageEvent): OtelAttributes {
  // The span helper owns the provider and model mapping; a point keeps the attributes the
  // convention allows on usage counters.
  const spanAttributes = usageRecordAttributes({ ...event, kind: 'usage' });
  const attributes: OtelAttributes = { 'gen_ai.operation.name': 'chat' };

  for (const key of ['gen_ai.provider.name', 'gen_ai.response.model'] as const) {
    if (key in spanAttributes) {
      attributes[key] = spanAttributes[key];
    }
  }

  attributes['gen_ai.token.modality'] = 'unknown';

  if (event.machine !== undefined) {
    attributes['llm_usage.machine'] = event.machine;
  }

  return attributes;
}

function collectBuckets(input: OtlpMetricsInput): Bucket[] {
  const buckets = new Map<string, Bucket>();

  for (const event of input.usageEvents) {
    const dateKey = getPeriodKey(event.timestamp, 'daily', input.timezone);
    const bucketKey = `${dateKey}\0${event.source}`;
    let bucket = buckets.get(bucketKey);

    if (!bucket) {
      bucket = { dateKey, source: event.source, points: new Map() };
      buckets.set(bucketKey, bucket);
    }

    const attributes = pointAttributes(event);
    // `join` writes an absent attribute as an empty string.
    const key = [
      attributes['gen_ai.provider.name'],
      attributes['gen_ai.response.model'],
      attributes['llm_usage.machine'],
    ].join('\0');
    let group = bucket.points.get(key);

    if (!group) {
      group = { key, attributes, totals: createEmptyTotals() };
      bucket.points.set(key, group);
    }

    addEventToTotals(group.totals, event);
  }

  return [...buckets.values()].sort(
    (left, right) =>
      compareByCodePoint(left.dateKey, right.dateKey) ||
      compareByCodePoint(left.source, right.source),
  );
}

function bucketMetrics(bucket: Bucket, timezone: string): OtlpMetricsData {
  const startTimeUnixNano = toUnixNanos(getLocalDayStartMs(bucket.dateKey, timezone));
  const timeUnixNano = toUnixNanos(getLocalDayStartMs(shiftDateKey(bucket.dateKey, 1), timezone));
  const groups = [...bucket.points.values()].sort((left, right) =>
    compareByCodePoint(left.key, right.key),
  );
  const toSum = (dataPoints: OtlpNumberDataPoint[]): OtlpMetric['sum'] => ({
    dataPoints,
    aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
    isMonotonic: true,
  });
  const metrics: OtlpMetric[] = TOKEN_METRICS.map((metric) => ({
    name: metric.name,
    description: metric.description,
    unit: '{token}',
    sum: toSum(
      groups.map((group) => ({
        attributes: toOtlpAttributes(group.attributes),
        startTimeUnixNano,
        timeUnixNano,
        asInt: String(metric.value(group.totals)),
      })),
    ),
  }));
  const costPoints: OtlpNumberDataPoint[] = groups.flatMap((group) =>
    group.totals.costUsd === undefined
      ? []
      : [
          {
            attributes: toOtlpAttributes(group.attributes),
            startTimeUnixNano,
            timeUnixNano,
            asDouble: group.totals.costUsd,
          },
        ],
  );

  if (costPoints.length > 0) {
    metrics.push({ ...COST_METRIC, unit: 'USD', sum: toSum(costPoints) });
  }

  return {
    resourceMetrics: [
      {
        resource: createAgentResource(bucket.source),
        scopeMetrics: [{ scope: OTLP_SCOPE, metrics, schemaUrl: OTLP_SCHEMA_URL }],
      },
    ],
  };
}

/**
 * One `MetricsData` per agent and local day, by day then agent: DELTA monotonic Sums of the
 * `gen_ai.client.inference.usage.*` token counters and of `llm_usage.cost_usd`, one point
 * per provider, model and machine, stamped with the day's bounds in `timezone`.
 */
export function buildOtlpMetrics(input: OtlpMetricsInput): OtlpMetricsData[] {
  return collectBuckets(input).map((bucket) => bucketMetrics(bucket, input.timezone));
}
