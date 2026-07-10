import { readFile } from 'node:fs/promises';

import { asRecord } from '../utils/as-record.js';
import { asTrimmedText, toNumberLike } from '../sources/parsing-utils.js';
import type { NumberLike } from '../domain/normalization.js';
import type { ModelPricing, PricingSource, ReasoningBillingMode } from './types.js';

// A user-maintained JSON file of per-model pricing that takes precedence over
// the LiteLLM pricing source. Useful for internal/custom models, discounted
// rates, or correcting values you disagree with.
//
// Shape:
// {
//   "models": {
//     "my-internal-model": { "inputPer1MUsd": 1, "outputPer1MUsd": 2 },
//     "claude-opus-4-8": { "inputPer1MUsd": 12, "outputPer1MUsd": 60 }
//   }
// }

type RawPricingOverride = {
  inputPer1MUsd?: unknown;
  outputPer1MUsd?: unknown;
  cacheReadPer1MUsd?: unknown;
  cacheWritePer1MUsd?: unknown;
  reasoningPer1MUsd?: unknown;
  reasoningBilling?: unknown;
};

function toFiniteUsdRate(value: NumberLike): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeReasoningBilling(value: unknown): ReasoningBillingMode | undefined {
  if (value === 'included-in-output' || value === 'separate') {
    return value;
  }

  return undefined;
}

function normalizePricingOverride(raw: RawPricingOverride): ModelPricing | undefined {
  const inputPer1MUsd = toFiniteUsdRate(toNumberLike(raw.inputPer1MUsd));
  const outputPer1MUsd = toFiniteUsdRate(toNumberLike(raw.outputPer1MUsd));

  if (inputPer1MUsd === undefined || outputPer1MUsd === undefined) {
    return undefined;
  }

  const cacheReadPer1MUsd = toFiniteUsdRate(toNumberLike(raw.cacheReadPer1MUsd));
  const cacheWritePer1MUsd = toFiniteUsdRate(toNumberLike(raw.cacheWritePer1MUsd));
  const reasoningPer1MUsd = toFiniteUsdRate(toNumberLike(raw.reasoningPer1MUsd));
  const reasoningBilling = normalizeReasoningBilling(raw.reasoningBilling);

  return {
    inputPer1MUsd,
    outputPer1MUsd,
    ...(cacheReadPer1MUsd !== undefined ? { cacheReadPer1MUsd } : {}),
    ...(cacheWritePer1MUsd !== undefined ? { cacheWritePer1MUsd } : {}),
    ...(reasoningPer1MUsd !== undefined ? { reasoningPer1MUsd } : {}),
    ...(reasoningBilling !== undefined ? { reasoningBilling } : {}),
  };
}

function normalizeOverrideFile(payload: unknown): Map<string, ModelPricing> {
  const root = asRecord(payload);
  const overrides = new Map<string, ModelPricing>();
  const modelsRecord = asRecord(root?.models);

  if (!modelsRecord) {
    return overrides;
  }

  for (const [modelName, rawPricing] of Object.entries(modelsRecord)) {
    const normalizedModelName = asTrimmedText(modelName)?.toLowerCase();

    if (!normalizedModelName) {
      continue;
    }

    const pricing = normalizePricingOverride(asRecord(rawPricing) ?? {});

    if (pricing) {
      overrides.set(normalizedModelName, pricing);
    }
  }

  return overrides;
}

export async function loadPricingOverrides(filePath: string): Promise<Map<string, ModelPricing>> {
  const fileContents = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(fileContents) as unknown;

  return normalizeOverrideFile(parsed);
}

export class PricingOverrideSource implements PricingSource {
  private readonly overrides: Map<string, ModelPricing>;
  private readonly delegate: PricingSource;

  public constructor(overrides: Map<string, ModelPricing>, delegate: PricingSource) {
    this.overrides = overrides;
    this.delegate = delegate;
  }

  public resolveModelAlias(model: string): string {
    // Override keys are matched on the raw model name (lowercased). If a model
    // has an override, skip the delegate's alias resolution so the override
    // wins unambiguously; otherwise defer to the delegate (LiteLLM).
    if (this.overrides.has(model.toLowerCase())) {
      return model;
    }

    return this.delegate.resolveModelAlias(model);
  }

  public getPricing(model: string): ModelPricing | undefined {
    const override = this.overrides.get(model.toLowerCase());

    if (override) {
      return override;
    }

    return this.delegate.getPricing(model);
  }
}
