import { describe, expect, it } from 'vitest';

import type { ExplainedModelPricing } from '@ayagmar/agent-sessions/pricing';

import { renderPricingReport } from '../../src/render/render-pricing-report.js';
import { visibleWidth } from '../../src/render/table-text-layout.js';
import { markerPalette } from '../helpers/marker-palette.js';
import { overrideStdoutProperty } from '../helpers/stdout.js';

const pricingUrl =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const tieredModel: ExplainedModelPricing = {
  model: 'gpt-5.4-high',
  normalizedModel: 'gpt-5.4-high',
  pricingKey: 'gpt-5.4',
  rule: 'effort-suffix',
  canonicalModel: null,
  strippedModel: 'gpt-5.4',
  fuzzyDistance: null,
  override: 'none',
  origin: { kind: 'cache', fetchedAt: '2026-10-15T08:00:00.000Z', url: pricingUrl },
  retired: false,
  rates: {
    inputPer1MUsd: 2.5,
    outputPer1MUsd: 15,
    cacheReadPer1MUsd: 0.25,
    cacheWritePer1MUsd: null,
    cacheWrite1hPer1MUsd: null,
    reasoningPer1MUsd: null,
    reasoningBilling: 'included-in-output',
  },
  tiers: [
    {
      aboveTokens: 272_000,
      inputPer1MUsd: 5,
      outputPer1MUsd: 22.5,
      cacheReadPer1MUsd: 0.5,
      cacheWritePer1MUsd: null,
      cacheWrite1hPer1MUsd: null,
    },
  ],
  priorityFallback: [],
};

function render(terminalWidth: number | undefined, useColor = false): string {
  return renderPricingReport({ models: [tieredModel] }, 'terminal', {
    useColor,
    terminalWidth,
    palette: markerPalette,
  });
}

describe('renderPricingReport', () => {
  // The pricing URL is the one exception: it stays whole, to click or copy.
  it.each([44, 80, 120])('keeps every line but the URL within %i columns', (terminalWidth) => {
    const lines = render(terminalWidth).split('\n');
    const tooWide = lines.filter((line) => visibleWidth(line) > terminalWidth);

    expect(tooWide.map((line) => line.trim())).toEqual(
      terminalWidth < 120 ? [`(${pricingUrl})`] : [],
    );
  });

  it('continues a wrapped value under its first line, keeping the URL whole', () => {
    const lines = render(80).split('\n');
    const pricesFromIndex = lines.findIndex((line) => line.startsWith('  Prices from'));
    const valueColumn = lines[pricesFromIndex].indexOf('LiteLLM cache');

    expect(lines[pricesFromIndex]).toBe(`  Prices from     LiteLLM cache from 2026-10-15`);
    expect(lines[pricesFromIndex + 1]).toBe(`${' '.repeat(valueColumn)}(${pricingUrl})`);
  });

  it('wraps the "Above N" note to the terminal width', () => {
    const noteLines = render(80).split('\n').slice(-3);

    expect(noteLines[0]).toMatch(/^"Above N" rates apply per request/u);
    expect(noteLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it('leaves piped output unwrapped', () => {
    const restoreStdout = overrideStdoutProperty('isTTY', false);

    try {
      expect(render(undefined)).toContain(`LiteLLM cache from 2026-10-15 (${pricingUrl})`);
    } finally {
      restoreStdout();
    }
  });

  it('colors rates as money and leaves rates that are not listed uncolored', () => {
    const lines = render(120, true).split('\n');
    const inputLine = lines.find((line) => line.includes('$2.50 / 1M'));
    const cacheWriteLine = lines.find((line) => line.includes('not listed'));

    expect(inputLine).toBe('  <dim>Input         </dim>  <yellow>$2.50 / 1M</yellow>');
    expect(cacheWriteLine).not.toContain('<yellow>');
  });
});
