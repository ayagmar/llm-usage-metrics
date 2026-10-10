import { asRecord } from '../utils/as-record.js';
import { readRegularTextFile } from '../utils/fs-helpers.js';
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

const requiredRateKeys = ['inputPer1MUsd', 'outputPer1MUsd'] as const;
const optionalRateKeys = [
  'cacheReadPer1MUsd',
  'cacheWritePer1MUsd',
  'cacheWrite1hPer1MUsd',
  'reasoningPer1MUsd',
] as const;
const knownOverrideKeys = new Set<string>([
  ...requiredRateKeys,
  ...optionalRateKeys,
  'reasoningBilling',
]);

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

function readRate(
  raw: Record<string, unknown>,
  key: string,
  required: boolean,
  problems: string[],
): number | undefined {
  const value = raw[key];

  if (value === undefined || value === null) {
    if (required) {
      problems.push(`${key} is required`);
    }

    return undefined;
  }

  const rate = toFiniteUsdRate(toNumberLike(value));

  if (rate === undefined) {
    problems.push(`${key} must be a non-negative number`);
  }

  return rate;
}

/** Returns the pricing, or pushes why the entry is invalid onto `problems`. */
function normalizePricingOverride(
  raw: Record<string, unknown>,
  problems: string[],
): ModelPricing | undefined {
  const problemCount = problems.length;

  for (const key of Object.keys(raw)) {
    if (!knownOverrideKeys.has(key)) {
      problems.push(`unknown key "${key}"`);
    }
  }

  const inputPer1MUsd = readRate(raw, 'inputPer1MUsd', true, problems);
  const outputPer1MUsd = readRate(raw, 'outputPer1MUsd', true, problems);
  const cacheReadPer1MUsd = readRate(raw, 'cacheReadPer1MUsd', false, problems);
  const cacheWritePer1MUsd = readRate(raw, 'cacheWritePer1MUsd', false, problems);
  const cacheWrite1hPer1MUsd = readRate(raw, 'cacheWrite1hPer1MUsd', false, problems);
  const reasoningPer1MUsd = readRate(raw, 'reasoningPer1MUsd', false, problems);
  const reasoningBilling = normalizeReasoningBilling(raw.reasoningBilling);

  if (raw.reasoningBilling !== undefined && reasoningBilling === undefined) {
    problems.push('reasoningBilling must be "included-in-output" or "separate"');
  }

  if (
    problems.length > problemCount ||
    inputPer1MUsd === undefined ||
    outputPer1MUsd === undefined
  ) {
    return undefined;
  }

  return {
    inputPer1MUsd,
    outputPer1MUsd,
    ...(cacheReadPer1MUsd !== undefined ? { cacheReadPer1MUsd } : {}),
    ...(cacheWritePer1MUsd !== undefined ? { cacheWritePer1MUsd } : {}),
    ...(cacheWrite1hPer1MUsd !== undefined ? { cacheWrite1hPer1MUsd } : {}),
    ...(reasoningPer1MUsd !== undefined ? { reasoningPer1MUsd } : {}),
    ...(reasoningBilling !== undefined ? { reasoningBilling } : {}),
  };
}

// A malformed entry fails the load: silently dropping it would price the model
// from LiteLLM while the user believes their override applied.
function normalizeOverrideFile(payload: unknown): Map<string, ModelPricing> {
  const modelsRecord = asRecord(asRecord(payload)?.models);

  if (!modelsRecord) {
    throw new Error('expected a JSON object with a "models" object');
  }

  const overrides = new Map<string, ModelPricing>();
  const problems: string[] = [];

  for (const [modelName, rawPricing] of Object.entries(modelsRecord)) {
    const normalizedModelName = asTrimmedText(modelName)?.toLowerCase();

    if (!normalizedModelName) {
      problems.push('model names must be non-empty');
      continue;
    }

    const rawRecord = asRecord(rawPricing);

    if (!rawRecord) {
      problems.push(`"${modelName}": expected an object of per-1M-token USD rates`);
      continue;
    }

    const entryProblems: string[] = [];
    const pricing = normalizePricingOverride(rawRecord, entryProblems);

    if (pricing) {
      overrides.set(normalizedModelName, pricing);
    } else {
      problems.push(`"${modelName}": ${entryProblems.join(', ')}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `invalid entries: ${problems.join('; ')} (valid keys: ${[...knownOverrideKeys].join(', ')})`,
    );
  }

  return overrides;
}

export async function loadPricingOverrides(filePath: string): Promise<Map<string, ModelPricing>> {
  const fileContents = await readRegularTextFile(filePath);
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
