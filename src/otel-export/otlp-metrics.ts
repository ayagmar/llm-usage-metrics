import type { ToolCallEvent } from '@ayagmar/agent-sessions';
import {
  toolCallAttributes,
  usageRecordAttributes,
  type OtelAttributes,
} from '@ayagmar/agent-sessions/otel';
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
  toAgentName,
  toolCallBoundsMs,
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

export type OtlpHistogramDataPoint = {
  attributes: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  bucketCounts: string[];
  explicitBounds: readonly number[];
  min: number;
  max: number;
};

export type OtlpMetric = {
  name: string;
  description: string;
  unit: string;
} & (
  | {
      sum: {
        dataPoints: OtlpNumberDataPoint[];
        aggregationTemporality: number;
        isMonotonic: true;
      };
    }
  | { histogram: { dataPoints: OtlpHistogramDataPoint[]; aggregationTemporality: number } }
);

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
  /** The exported sessions' tool calls, deduplicated; only calls with a duration count. */
  toolCalls: readonly ToolCallEvent[];
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

// The bucket boundaries the pinned docs advise (docs/gen-ai/gen-ai-token-metrics.md and
// gen-ai-metrics.md).
const TOKEN_BOUNDS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];
// In milliseconds, so the sums stay whole whatever order the calls arrive in; the points
// carry seconds (0.01 to 81.92).
const DURATION_BOUNDS_MS: readonly number[] = [
  10, 20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480, 40960, 81920,
];

// The per-inference token distributions. Not broken down by modality, as the convention asks.
const TOKEN_HISTOGRAMS = [
  {
    name: 'gen_ai.client.inference.operation.input_tokens',
    description: 'Input tokens per inference, including cache reads and cache writes.',
    value: (event: UsageEvent) =>
      event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens,
  },
  {
    name: 'gen_ai.client.inference.operation.output_tokens',
    description: 'Output tokens per inference, including reasoning tokens.',
    value: (event: UsageEvent) => event.outputTokens,
  },
] as const;

const TOOL_DURATION_METRIC = {
  name: 'gen_ai.execute_tool.duration',
  description: 'Tool call duration, for calls whose log records when they ended.',
};

const COST_METRIC = {
  name: 'llm_usage.cost_usd',
  description: 'Cost in US dollars, logged or estimated. Unpriced usage adds nothing.',
};

/** An explicit-bucket histogram being filled. */
type Histogram = {
  bounds: readonly number[];
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[];
};

/** The usage of one attribute set in one bucket. */
type PointGroup = {
  /** Provider name, model and machine joined by NUL: sorting keys sorts the tuples. */
  key: string;
  attributes: OtelAttributes;
  totals: UsageTotals;
  /** One histogram per `TOKEN_HISTOGRAMS` entry, in that order. */
  tokenHistograms: Histogram[];
};

/** The durations of one tool name and outcome in one bucket. */
type ToolGroup = {
  /** Tool name and error type joined by NUL. */
  key: string;
  attributes: OtelAttributes;
  durations: Histogram;
};

/** One agent's usage and tool calls in one local day. */
type Bucket = {
  dateKey: string;
  source: string;
  points: Map<string, PointGroup>;
  tools: Map<string, ToolGroup>;
};

function createHistogram(bounds: readonly number[]): Histogram {
  return {
    bounds,
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    bucketCounts: Array.from({ length: bounds.length + 1 }, () => 0),
  };
}

/** Bucket `i` holds values in `(bounds[i - 1], bounds[i]]`; the last one holds the rest. */
function recordValue(histogram: Histogram, value: number): void {
  const index = histogram.bounds.findIndex((bound) => value <= bound);
  histogram.bucketCounts[index === -1 ? histogram.bounds.length : index] += 1;
  histogram.count += 1;
  histogram.sum += value;
  histogram.min = Math.min(histogram.min, value);
  histogram.max = Math.max(histogram.max, value);
}

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

function toolPointAttributes(call: ToolCallEvent): OtelAttributes {
  // The tool attributes the duration metric allows; the span helper owns their mapping.
  const spanAttributes = toolCallAttributes(call);
  const attributes: OtelAttributes = {
    'gen_ai.tool.name': spanAttributes['gen_ai.tool.name'],
    'gen_ai.agent.name': toAgentName(call.source),
  };

  if ('error.type' in spanAttributes) {
    attributes['error.type'] = spanAttributes['error.type'];
  }

  return attributes;
}

function collectBuckets(input: OtlpMetricsInput): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const bucketFor = (timestamp: string, source: string): Bucket => {
    const dateKey = getPeriodKey(timestamp, 'daily', input.timezone);
    const bucketKey = `${dateKey}\0${source}`;
    let bucket = buckets.get(bucketKey);

    if (!bucket) {
      bucket = { dateKey, source, points: new Map(), tools: new Map() };
      buckets.set(bucketKey, bucket);
    }

    return bucket;
  };

  for (const event of input.usageEvents) {
    const bucket = bucketFor(event.timestamp, event.source);
    const attributes = pointAttributes(event);
    // `join` writes an absent attribute as an empty string.
    const key = [
      attributes['gen_ai.provider.name'],
      attributes['gen_ai.response.model'],
      attributes['llm_usage.machine'],
    ].join('\0');
    let group = bucket.points.get(key);

    if (!group) {
      group = {
        key,
        attributes,
        totals: createEmptyTotals(),
        tokenHistograms: TOKEN_HISTOGRAMS.map(() => createHistogram(TOKEN_BOUNDS)),
      };
      bucket.points.set(key, group);
    }

    addEventToTotals(group.totals, event);
    TOKEN_HISTOGRAMS.forEach((metric, index) => {
      recordValue(group.tokenHistograms[index], metric.value(event));
    });
  }

  for (const call of input.toolCalls) {
    const { startMs, endMs, measured } = toolCallBoundsMs(call);

    // A zero-length call has no measured duration: its result shares its record (Codex web
    // search) or was logged before the call.
    if (!measured || endMs === startMs) {
      continue;
    }

    const tools = bucketFor(call.timestamp, call.source).tools;
    const attributes = toolPointAttributes(call);
    const key = [attributes['gen_ai.tool.name'], attributes['error.type']].join('\0');
    let group = tools.get(key);

    if (!group) {
      group = { key, attributes, durations: createHistogram(DURATION_BOUNDS_MS) };
      tools.set(key, group);
    }

    recordValue(group.durations, endMs - startMs);
  }

  return [...buckets.values()].sort(
    (left, right) =>
      compareByCodePoint(left.dateKey, right.dateKey) ||
      compareByCodePoint(left.source, right.source),
  );
}

function withoutModality(attributes: OtelAttributes): OtelAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => key !== 'gen_ai.token.modality'),
  );
}

function bucketMetrics(bucket: Bucket, timezone: string): OtlpMetricsData {
  const startTimeUnixNano = toUnixNanos(getLocalDayStartMs(bucket.dateKey, timezone));
  const timeUnixNano = toUnixNanos(getLocalDayStartMs(shiftDateKey(bucket.dateKey, 1), timezone));
  const byKey = (left: { key: string }, right: { key: string }) =>
    compareByCodePoint(left.key, right.key);
  const groups = [...bucket.points.values()].sort(byKey);
  const toolGroups = [...bucket.tools.values()].sort(byKey);
  const toSum = (dataPoints: OtlpNumberDataPoint[]) => ({
    dataPoints,
    aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
    isMonotonic: true as const,
  });
  /** A point of `histogram`, its values divided by `scale` (milliseconds to seconds). */
  const toHistogramPoint = (
    attributes: OtelAttributes,
    histogram: Histogram,
    scale = 1,
  ): OtlpHistogramDataPoint => ({
    attributes: toOtlpAttributes(attributes),
    startTimeUnixNano,
    timeUnixNano,
    count: String(histogram.count),
    sum: histogram.sum / scale,
    bucketCounts: histogram.bucketCounts.map(String),
    explicitBounds: histogram.bounds.map((bound) => bound / scale),
    min: histogram.min / scale,
    max: histogram.max / scale,
  });
  const toHistogram = (dataPoints: OtlpHistogramDataPoint[]) => ({
    dataPoints,
    aggregationTemporality: AGGREGATION_TEMPORALITY_DELTA,
  });
  const metrics: OtlpMetric[] = [];

  if (groups.length > 0) {
    metrics.push(
      ...TOKEN_METRICS.map((metric) => ({
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
      })),
    );
  }

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

  if (groups.length > 0) {
    metrics.push(
      ...TOKEN_HISTOGRAMS.map((metric, index) => ({
        name: metric.name,
        description: metric.description,
        unit: '{token}',
        histogram: toHistogram(
          groups.map((group) =>
            toHistogramPoint(withoutModality(group.attributes), group.tokenHistograms[index]),
          ),
        ),
      })),
    );
  }

  if (toolGroups.length > 0) {
    metrics.push({
      ...TOOL_DURATION_METRIC,
      unit: 's',
      histogram: toHistogram(
        toolGroups.map((group) => toHistogramPoint(group.attributes, group.durations, 1000)),
      ),
    });
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
 * `gen_ai.client.inference.usage.*` token counters and of `llm_usage.cost_usd`, and DELTA
 * histograms of the per-inference token counts, one point per provider, model and machine;
 * then a DELTA histogram of tool call durations, one point per tool name and outcome. Points
 * carry the day's bounds in `timezone`; a tool call counts in the day it started.
 */
export function buildOtlpMetrics(input: OtlpMetricsInput): OtlpMetricsData[] {
  return collectBuckets(input).map((bucket) => bucketMetrics(bucket, input.timezone));
}
