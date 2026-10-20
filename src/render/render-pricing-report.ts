import { markdownTable } from 'markdown-table';

import type {
  ExplainedModelPricing,
  ExplainedTier,
  PricingReportData,
} from '@ayagmar/agent-sessions/pricing';
import { formatInteger } from './format-number.js';
import { toMarkdownSafeCell, toMarkdownSafeCodeCell } from './markdown-safe-cell.js';
import { renderReportHeader } from './report-header.js';
import { renderReportJson } from './report-json.js';
import { shouldUseColorByDefault } from './terminal-table.js';

export type PricingReportFormat = 'terminal' | 'markdown' | 'json';

type Field = [label: string, value: string];

const originLabels: Record<NonNullable<ExplainedModelPricing['origin']>['kind'], string> = {
  cache: 'LiteLLM cache',
  network: 'LiteLLM, fetched now',
  'bundled-snapshot': 'bundled LiteLLM snapshot',
};

const rateFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatRate(rate: number | null): string {
  return rate === null ? 'not listed' : `${rateFormatter.format(rate)} / 1M`;
}

function describeMatch(model: ExplainedModelPricing): string {
  if (model.override === 'raw') {
    return 'override keyed on the name';
  }

  if (model.rule === null) {
    // No key matched, so the override is keyed on the normalized name itself.
    return model.override === 'resolved'
      ? 'override keyed on the normalized name'
      : 'no pricing key matched';
  }

  const stripped = model.strippedModel === null ? '' : ` (as ${model.strippedModel})`;
  const rule = {
    'preferred-key': "the model map's preferred key",
    direct: `direct${stripped}`,
    'effort-suffix': `effort suffix dropped${stripped}`,
    'provider-prefixed': `provider-prefixed key${stripped}`,
    'release-suffix': `key plus a release suffix${stripped}`,
    fuzzy: `fuzzy${stripped}, edit distance ${model.fuzzyDistance ?? 0}`,
  }[model.rule];

  return model.canonicalModel === null
    ? rule
    : `model map to ${model.canonicalModel}, then ${rule}`;
}

function describeOverride(model: ExplainedModelPricing): string {
  return {
    raw: 'yes, keyed on the name',
    resolved: 'yes, keyed on the pricing key',
    none: 'none',
  }[model.override];
}

function describeOrigin(model: ExplainedModelPricing): string {
  if (model.origin === null) {
    return model.override === 'none' ? 'none' : 'pricing overrides file';
  }

  const fetchedDate = model.origin.fetchedAt.slice(0, 10);
  return `${originLabels[model.origin.kind]} from ${fetchedDate} (${model.origin.url})`;
}

function describeTier(tier: ExplainedTier): string {
  const rates: [string, number | null][] = [
    ['input', tier.inputPer1MUsd],
    ['output', tier.outputPer1MUsd],
    ['cache read', tier.cacheReadPer1MUsd],
    ['cache write', tier.cacheWritePer1MUsd],
    ['cache write 1h', tier.cacheWrite1hPer1MUsd],
  ];

  return rates
    .filter(([, rate]) => rate !== null)
    .map(([label, rate]) => `${label} ${formatRate(rate)}`)
    .join(', ');
}

/** The name as given, quoted when surrounding whitespace would otherwise not show. */
function formatModelName(model: string): string {
  return model === model.trim() ? model : JSON.stringify(model);
}

function toFields(model: ExplainedModelPricing): Field[] {
  const fields: Field[] = [
    ['Normalized', model.normalizedModel],
    ['Pricing key', model.pricingKey ?? 'unpriced'],
    ['Rule', describeMatch(model)],
    ['Override', describeOverride(model)],
    [model.pricingKey === null ? 'Searched' : 'Prices from', describeOrigin(model)],
  ];

  if (model.retired) {
    fields.push(['Retired', 'yes, priced from retired LiteLLM prices']);
  }

  const { rates } = model;

  if (rates === null) {
    return fields;
  }

  fields.push(
    ['Input', formatRate(rates.inputPer1MUsd)],
    ['Output', formatRate(rates.outputPer1MUsd)],
    ['Cache read', formatRate(rates.cacheReadPer1MUsd)],
    ['Cache write', formatRate(rates.cacheWritePer1MUsd)],
    [
      'Cache write 1h',
      rates.cacheWrite1hPer1MUsd === null
        ? 'as cache write'
        : formatRate(rates.cacheWrite1hPer1MUsd),
    ],
    [
      'Reasoning',
      rates.reasoningBilling === 'separate'
        ? formatRate(rates.reasoningPer1MUsd)
        : 'billed as output',
    ],
  );

  for (const tier of model.tiers) {
    fields.push([`Above ${formatInteger(tier.aboveTokens)}`, describeTier(tier)]);
  }

  if (model.priorityFallback.length > 0) {
    fields.push(['Priority rates', `stand in for ${model.priorityFallback.join(', ')}`]);
  }

  return fields;
}

function describeNotes(data: PricingReportData): string[] {
  if (!data.models.some((model) => model.tiers.length > 0)) {
    return [];
  }

  return [
    '"Above N" rates apply per request when its prompt (input, cache read and cache write tokens) is above N, and only to events that record one request. Events that sum several requests, such as session totals, stay at base rates.',
  ];
}

function renderTerminalPricingReport(data: PricingReportData): string {
  const lines = [
    renderReportHeader({ title: 'Model Pricing', useColor: shouldUseColorByDefault() }),
  ];

  for (const model of data.models) {
    const fields = toFields(model);
    const labelWidth = Math.max(...fields.map(([label]) => label.length));
    lines.push(
      '',
      formatModelName(model.model),
      ...fields.map(([label, value]) => `  ${label.padEnd(labelWidth)}  ${value}`),
    );
  }

  const notes = describeNotes(data);

  if (notes.length > 0) {
    lines.push('', ...notes);
  }

  return lines.join('\n');
}

function renderMarkdownPricingReport(data: PricingReportData): string {
  const sections = data.models.map((model) =>
    [
      `### ${toMarkdownSafeCodeCell(formatModelName(model.model))}`,
      '',
      markdownTable(
        [
          ['Field', 'Value'],
          ...toFields(model).map(([label, value]) => [label, toMarkdownSafeCell(value)]),
        ],
        { align: ['l', 'l'] },
      ),
    ].join('\n'),
  );

  return [...sections, ...describeNotes(data)].join('\n\n');
}

export function renderPricingReport(data: PricingReportData, format: PricingReportFormat): string {
  switch (format) {
    case 'json':
      return renderReportJson('pricing', data);
    case 'markdown':
      return renderMarkdownPricingReport(data);
    case 'terminal':
      return renderTerminalPricingReport(data);
  }
}
