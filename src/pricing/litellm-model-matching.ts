import { asRecord } from '../utils/as-record.js';
import { compareByCodePoint } from '../utils/compare-by-code-point.js';
import litellmModelMapPayload from './litellm-model-map.json' with { type: 'json' };
import type { ModelPricing } from './types.js';

type LiteLLMModelMapPayload = {
  aliases?: unknown;
  neverFuzzyMatch?: unknown;
  preferredPricingKeyByCanonicalModel?: unknown;
};

type LiteLLMModelMap = {
  aliasToCanonicalModel: Map<string, string>;
  canonicalizedAliasToCanonicalModel: Map<string, string>;
  neverFuzzyMatch: Set<string>;
  preferredPricingKeyByCanonicalModel: Map<string, string>;
};

export function normalizeKey(value: string): string {
  // Pricing payload keys are normalized separately from event/cache model keys.
  return value.trim().toLowerCase();
}

function parseLiteLLMModelMap(payload: LiteLLMModelMapPayload): LiteLLMModelMap {
  const aliasToCanonicalModel = new Map<string, string>();
  const canonicalizedAliasToCanonicalModel = new Map<string, string>();
  const neverFuzzyMatch = new Set<string>();
  const preferredPricingKeyByCanonicalModel = new Map<string, string>();
  const aliasesRecord = asRecord(payload.aliases);
  if (aliasesRecord) {
    for (const [alias, canonicalModel] of Object.entries(aliasesRecord)) {
      if (typeof canonicalModel !== 'string') {
        continue;
      }
      const normalizedAlias = normalizeKey(alias);
      const normalizedCanonicalModel = normalizeKey(canonicalModel);
      aliasToCanonicalModel.set(normalizedAlias, normalizedCanonicalModel);
      canonicalizedAliasToCanonicalModel.set(
        canonicalizeForFuzzy(normalizedAlias),
        normalizedCanonicalModel,
      );
    }
  }
  if (Array.isArray(payload.neverFuzzyMatch)) {
    for (const model of payload.neverFuzzyMatch) {
      if (typeof model !== 'string') {
        continue;
      }
      neverFuzzyMatch.add(normalizeKey(model));
    }
  }
  const preferredPricingRecord = asRecord(payload.preferredPricingKeyByCanonicalModel);
  if (preferredPricingRecord) {
    for (const [canonicalModel, preferredPricingKey] of Object.entries(preferredPricingRecord)) {
      if (typeof preferredPricingKey !== 'string') {
        continue;
      }
      preferredPricingKeyByCanonicalModel.set(
        normalizeKey(canonicalModel),
        normalizeKey(preferredPricingKey),
      );
    }
  }
  return {
    aliasToCanonicalModel,
    canonicalizedAliasToCanonicalModel,
    neverFuzzyMatch,
    preferredPricingKeyByCanonicalModel,
  };
}

const litellmModelMap = parseLiteLLMModelMap(litellmModelMapPayload);

function stripProviderPrefix(model: string): string {
  const slashIndex = model.lastIndexOf('/');
  if (slashIndex === -1) {
    return model;
  }
  return model.slice(slashIndex + 1);
}

function canonicalizeForFuzzy(value: string): string {
  return value.replace(/[^a-z0-9]/gu, '');
}

function isPrefixModelMatch(candidate: string, modelName: string): boolean {
  if (!candidate.startsWith(modelName)) {
    return false;
  }
  if (candidate.length === modelName.length) {
    return true;
  }
  const nextCharacter = candidate[modelName.length];
  return nextCharacter === '-' || nextCharacter === ':' || nextCharacter === '@';
}

function extractNumericTokens(value: string): string[] {
  return value.match(/\d+/gu) ?? [];
}

function areNumericSignaturesCompatible(left: string, right: string): boolean {
  const leftTokens = extractNumericTokens(left);
  const rightTokens = extractNumericTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return true;
  }
  if (
    leftTokens.length === rightTokens.length &&
    leftTokens.every((token, index) => token === rightTokens[index])
  ) {
    return true;
  }
  if (leftTokens.length === 1 && rightTokens.length > 1 && rightTokens.join('') === leftTokens[0]) {
    return true;
  }
  if (rightTokens.length === 1 && leftTokens.length > 1 && leftTokens.join('') === rightTokens[0]) {
    return true;
  }
  return false;
}

function levenshteinDistance(left: string, right: string): number {
  const leftLength = left.length;
  const rightLength = right.length;
  const matrix = Array.from({ length: leftLength + 1 }, (_, rowIndex) => {
    return Array.from({ length: rightLength + 1 }, (_, columnIndex) => {
      if (rowIndex === 0) {
        return columnIndex;
      }
      if (columnIndex === 0) {
        return rowIndex;
      }
      return 0;
    });
  });
  for (let rowIndex = 1; rowIndex <= leftLength; rowIndex += 1) {
    for (let columnIndex = 1; columnIndex <= rightLength; columnIndex += 1) {
      const substitutionCost = left[rowIndex - 1] === right[columnIndex - 1] ? 0 : 1;
      matrix[rowIndex][columnIndex] = Math.min(
        matrix[rowIndex - 1][columnIndex] + 1,
        matrix[rowIndex][columnIndex - 1] + 1,
        matrix[rowIndex - 1][columnIndex - 1] + substitutionCost,
      );
    }
  }
  return matrix[leftLength][rightLength];
}

function resolveMappedModelAlias(
  normalizedModel: string,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): string | undefined {
  const canonicalModel = resolveCanonicalModelName(normalizedModel);
  if (!canonicalModel) {
    return undefined;
  }
  const preferredPricingKey =
    litellmModelMap.preferredPricingKeyByCanonicalModel.get(canonicalModel);
  if (preferredPricingKey && pricingByModel.has(preferredPricingKey)) {
    return preferredPricingKey;
  }
  const directCanonicalMatch = resolveDirectModelMatch(canonicalModel, pricingByModel);
  if (directCanonicalMatch) {
    return directCanonicalMatch;
  }
  const providerPrefixedCanonicalMatch = resolveProviderPrefixedModelMatch(
    canonicalModel,
    pricingByModel,
  );
  if (providerPrefixedCanonicalMatch) {
    return providerPrefixedCanonicalMatch;
  }
  const prefixCanonicalMatch = resolvePrefixModelMatch(canonicalModel, pricingByModel);
  if (prefixCanonicalMatch) {
    return prefixCanonicalMatch;
  }
  return shouldSkipFuzzyModelMatch(canonicalModel)
    ? undefined
    : resolveFuzzyModelMatch(canonicalModel, pricingByModel);
}

function resolveCanonicalModelName(normalizedModel: string): string | undefined {
  const strippedModel = stripProviderPrefix(normalizedModel);
  const directCanonicalMatch =
    litellmModelMap.aliasToCanonicalModel.get(normalizedModel) ??
    litellmModelMap.aliasToCanonicalModel.get(strippedModel);
  if (directCanonicalMatch) {
    return directCanonicalMatch;
  }
  const canonicalizedModel = canonicalizeForFuzzy(normalizedModel);
  const canonicalizedStrippedModel = canonicalizeForFuzzy(strippedModel);
  return (
    litellmModelMap.canonicalizedAliasToCanonicalModel.get(canonicalizedModel) ??
    litellmModelMap.canonicalizedAliasToCanonicalModel.get(canonicalizedStrippedModel)
  );
}

function resolveDirectModelMatch(
  normalizedModel: string,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): string | undefined {
  if (pricingByModel.has(normalizedModel)) {
    return normalizedModel;
  }
  const strippedModel = stripProviderPrefix(normalizedModel);
  if (pricingByModel.has(strippedModel)) {
    return strippedModel;
  }
  return undefined;
}

function resolveProviderPrefixedModelMatch(
  normalizedModel: string,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): string | undefined {
  const candidates = [normalizedModel, stripProviderPrefix(normalizedModel)];
  for (const candidate of candidates) {
    let bestMatch: string | undefined;
    for (const modelName of pricingByModel.keys()) {
      const isProviderPrefixedMatch =
        modelName.endsWith(`/${candidate}`) || modelName.endsWith(`.${candidate}`);
      if (!isProviderPrefixedMatch) {
        continue;
      }
      if (
        !bestMatch ||
        modelName.length < bestMatch.length ||
        (modelName.length === bestMatch.length && compareByCodePoint(modelName, bestMatch) < 0)
      ) {
        bestMatch = modelName;
      }
    }
    if (bestMatch) {
      return bestMatch;
    }
  }
  return undefined;
}

function resolvePrefixModelMatch(
  normalizedModel: string,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): string | undefined {
  const candidates = [normalizedModel, stripProviderPrefix(normalizedModel)];
  for (const candidate of candidates) {
    let bestMatch: string | undefined;
    for (const modelName of pricingByModel.keys()) {
      if (!isPrefixModelMatch(candidate, modelName)) {
        continue;
      }
      if (
        !bestMatch ||
        modelName.length > bestMatch.length ||
        (modelName.length === bestMatch.length && compareByCodePoint(modelName, bestMatch) < 0)
      ) {
        bestMatch = modelName;
      }
    }
    if (bestMatch) {
      return bestMatch;
    }
  }
  return undefined;
}

function shouldSkipFuzzyModelMatch(normalizedModel: string): boolean {
  const strippedModel = stripProviderPrefix(normalizedModel);
  return (
    litellmModelMap.neverFuzzyMatch.has(normalizedModel) ||
    litellmModelMap.neverFuzzyMatch.has(strippedModel)
  );
}

function resolveFuzzyModelMatch(
  normalizedModel: string,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): string | undefined {
  const strippedModel = stripProviderPrefix(normalizedModel);
  const fuzzyTarget = canonicalizeForFuzzy(strippedModel);
  if (!fuzzyTarget) {
    return undefined;
  }
  let bestMatch: { modelName: string; distance: number } | undefined;
  for (const modelName of pricingByModel.keys()) {
    if (!areNumericSignaturesCompatible(strippedModel, modelName)) {
      continue;
    }
    const fuzzyModelName = canonicalizeForFuzzy(modelName);
    if (!fuzzyModelName) {
      continue;
    }
    const distance = levenshteinDistance(fuzzyTarget, fuzzyModelName);
    if (!bestMatch || distance < bestMatch.distance) {
      bestMatch = { modelName, distance };
    }
  }
  if (!bestMatch) {
    return undefined;
  }
  const maxDistance = Math.max(2, Math.floor(fuzzyTarget.length * 0.2));
  if (bestMatch.distance > maxDistance) {
    return undefined;
  }
  return bestMatch.modelName;
}

export function resolveCanonicalModelKey(
  normalizedModel: string,
  pricingByModel: ReadonlyMap<string, ModelPricing>,
): string | undefined {
  const mappedAlias = resolveMappedModelAlias(normalizedModel, pricingByModel);
  if (mappedAlias) {
    return mappedAlias;
  }
  const directMatch = resolveDirectModelMatch(normalizedModel, pricingByModel);
  if (directMatch) {
    return directMatch;
  }
  const providerPrefixedMatch = resolveProviderPrefixedModelMatch(normalizedModel, pricingByModel);
  if (providerPrefixedMatch) {
    return providerPrefixedMatch;
  }
  const prefixMatch = resolvePrefixModelMatch(normalizedModel, pricingByModel);
  if (prefixMatch) {
    return prefixMatch;
  }
  return shouldSkipFuzzyModelMatch(normalizedModel)
    ? undefined
    : resolveFuzzyModelMatch(normalizedModel, pricingByModel);
}
