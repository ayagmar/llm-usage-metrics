import {
  explainCanonicalModelKey,
  normalizeKey,
  resolveCanonicalModelKey,
} from './litellm-model-matching.js';
import type {
  ModelPricing,
  ModelPricingExplanation,
  PricingDataOrigin,
  PricingSource,
} from './types.js';

export function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }

    return value;
  }

  if (typeof value === 'string') {
    if (value.trim() === '') {
      return undefined;
    }

    const parsedValue = Number(value);

    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
      return undefined;
    }

    return parsedValue;
  }

  return undefined;
}

/**
 * One key's positive limit from a record of limits keyed by normalized pricing key. Read one
 * entry at a time, so loading pricing never walks the thousands of limits only the context
 * report asks for.
 */
function readContextLimit(
  limits: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const limit = limits && Object.hasOwn(limits, key) ? toNonNegativeNumber(limits[key]) : undefined;

  return limit === 0 ? undefined : limit;
}

export type PricingTableOptions = {
  /** Context limits by normalized pricing key, as loaded with the rates. */
  maxInputTokensByModel?: Readonly<Record<string, unknown>>;
  /** Limits read for a key `maxInputTokensByModel` lists none for. */
  fallbackMaxInputTokensByModel?: Readonly<Record<string, unknown>>;
  origin?: PricingDataOrigin;
  /** Keys back-filled from the bundled retired prices. */
  retiredModelKeys?: ReadonlySet<string>;
};

/** A pricing source over rates keyed by normalized model key, matched by the LiteLLM matcher. */
export class PricingTable implements PricingSource {
  private readonly resolvedAliasCache = new Map<string, string>();

  public constructor(
    private readonly pricingByModel: ReadonlyMap<string, ModelPricing>,
    private readonly options: PricingTableOptions = {},
  ) {}

  public explainModel(model: string): ModelPricingExplanation {
    const normalizedModel = normalizeKey(model);
    const resolvedModel = this.resolveModelAlias(model);
    const pricing = this.getPricing(resolvedModel);
    const match = explainCanonicalModelKey(normalizedModel, this.pricingByModel);
    const { origin, retiredModelKeys } = this.options;

    return {
      normalizedModel,
      resolvedModel,
      ...(match ? { match } : {}),
      override: 'none',
      ...(origin ? { origin } : {}),
      retired: pricing !== undefined && (retiredModelKeys?.has(resolvedModel) ?? false),
      ...(pricing ? { pricing } : {}),
    };
  }

  public resolveModelAlias(model: string): string {
    const normalizedModel = normalizeKey(model);
    const cachedAlias = this.resolvedAliasCache.get(normalizedModel);

    if (cachedAlias) {
      return cachedAlias;
    }

    const resolvedAlias =
      resolveCanonicalModelKey(normalizedModel, this.pricingByModel) ?? normalizedModel;
    this.resolvedAliasCache.set(normalizedModel, resolvedAlias);

    return resolvedAlias;
  }

  public getPricing(model: string): ModelPricing | undefined {
    return this.pricingByModel.get(this.resolveModelAlias(model));
  }

  public getMaxInputTokens(model: string): number | undefined {
    const key = this.resolveModelAlias(model);

    return (
      readContextLimit(this.options.maxInputTokensByModel, key) ??
      readContextLimit(this.options.fallbackMaxInputTokensByModel, key)
    );
  }
}

/** Options for {@link createPricingSource}. */
export type PricingSourceOptions = {
  /** Each model's context limit in tokens (LiteLLM's `max_input_tokens`), keyed like the rates. */
  maxInputTokensByModel?: ReadonlyMap<string, number>;
  /** Where the rates came from; `explainModelPricing` reports it. */
  origin?: PricingDataOrigin;
};

/**
 * A pricing source over your own rates, keyed by model name. Names resolve to keys with the
 * same matcher the bundled LiteLLM prices use, so `claude-sonnet-4-5-20250929` finds a
 * `claude-sonnet-4-5` key. Keys are trimmed and lowercased; the maps are copied.
 */
export function createPricingSource(
  rates: ReadonlyMap<string, ModelPricing>,
  options: PricingSourceOptions = {},
): PricingSource {
  const maxInputTokensByModel = options.maxInputTokensByModel
    ? Object.fromEntries(
        [...options.maxInputTokensByModel].map(([model, limit]) => [normalizeKey(model), limit]),
      )
    : undefined;

  return new PricingTable(
    new Map([...rates].map(([model, pricing]) => [normalizeKey(model), pricing])),
    {
      ...(maxInputTokensByModel ? { maxInputTokensByModel } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
  );
}
