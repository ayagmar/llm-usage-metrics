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
import { resolveTtyColumns, splitCellLines, visibleWidth, wrapProse } from './table-text-layout.js';
import { createColorRoles, type TerminalStylePalette } from './terminal-style-policy.js';
import { shouldUseColorByDefault } from './terminal-table.js';

export type PricingReportFormat = 'terminal' | 'markdown' | 'json';

/** `money` marks a value that is a rate, colored as money in the terminal. */
type Field = [label: string, value: string, kind?: 'money'];

export type RenderPricingReportOptions = {
  useColor?: boolean;
  /** Defaults to the stdout TTY width; without one (piped output) nothing is wrapped. */
  terminalWidth?: number;
  palette?: TerminalStylePalette;
};

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

function toRateField(label: string, rate: number | null): Field {
  return rate === null ? [label, formatRate(rate)] : [label, formatRate(rate), 'money'];
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
    toRateField('Input', rates.inputPer1MUsd),
    toRateField('Output', rates.outputPer1MUsd),
    toRateField('Cache read', rates.cacheReadPer1MUsd),
    toRateField('Cache write', rates.cacheWritePer1MUsd),
    rates.cacheWrite1hPer1MUsd === null
      ? ['Cache write 1h', 'as cache write']
      : toRateField('Cache write 1h', rates.cacheWrite1hPer1MUsd),
    rates.reasoningBilling === 'separate'
      ? toRateField('Reasoning', rates.reasoningPer1MUsd)
      : ['Reasoning', 'billed as output'],
  );

  for (const tier of model.tiers) {
    fields.push([`Above ${formatInteger(tier.aboveTokens)}`, describeTier(tier), 'money']);
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

/** Wraps between words. A word wider than a line, such as the pricing URL, stays whole to copy. */
function wrapFieldValue(value: string, width: number): string[] {
  const lines: string[] = [];

  for (const word of value.split(' ')) {
    const lastLine = lines.at(-1);

    if (lastLine !== undefined && visibleWidth(`${lastLine} ${word}`) <= width) {
      lines[lines.length - 1] = `${lastLine} ${word}`;
    } else {
      lines.push(word);
    }
  }

  return lines;
}

function renderTerminalPricingReport(
  data: PricingReportData,
  options: RenderPricingReportOptions,
): string {
  const useColor = options.useColor ?? shouldUseColorByDefault();
  const terminalWidth = options.terminalWidth ?? resolveTtyColumns(process.stdout);
  const roles = createColorRoles(useColor, options.palette);
  const lines = [renderReportHeader({ title: 'Model Pricing', useColor, terminalWidth })];

  for (const model of data.models) {
    const fields = toFields(model);
    const labelWidth = Math.max(...fields.map(([label]) => label.length));
    const valueIndent = ' '.repeat(2 + labelWidth + 2);
    const valueWidth =
      terminalWidth === undefined ? undefined : Math.max(1, terminalWidth - valueIndent.length);

    lines.push('', roles.header(formatModelName(model.model)));

    for (const [label, value, kind] of fields) {
      const styleValue = kind === 'money' ? roles.money : roles.value;
      // A long value (the pricing URL, a tier) continues under its first line.
      const valueLines = (
        valueWidth === undefined ? [value] : wrapFieldValue(value, valueWidth)
      ).map(styleValue);
      lines.push(
        `  ${roles.label(label.padEnd(labelWidth))}  ${valueLines[0]}`,
        ...valueLines.slice(1).map((line) => `${valueIndent}${line}`),
      );
    }
  }

  const notes = describeNotes(data);

  if (notes.length > 0) {
    lines.push(
      '',
      ...notes.flatMap((note) => splitCellLines(wrapProse(note, terminalWidth)).map(roles.dim)),
    );
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

export function renderPricingReport(
  data: PricingReportData,
  format: PricingReportFormat,
  options: RenderPricingReportOptions = {},
): string {
  switch (format) {
    case 'json':
      return renderReportJson('pricing', data);
    case 'markdown':
      return renderMarkdownPricingReport(data);
    case 'terminal':
      return renderTerminalPricingReport(data, options);
  }
}
