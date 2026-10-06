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

// Release suffixes that leave the priced model unchanged: dates and snapshot ids
// (-20250929, -2025-09-29, -0613), -latest, Vertex @versions, Bedrock :n / -vN:n, and
// reasoning-effort labels that harnesses append (-low ... -xhigh, Claude's -thinking).
// Variant words (-mini, -flash, -max) and minor versions (-1) name a different model,
// so prefix matching must not bridge them. The suffix is split into separator-led
// segments and each is checked on its own, which keeps matching linear in its length.
const ISO_DATE_SEGMENT_PATTERN = /-(\d{4})-(\d{2})-(\d{2})(?=$|[-@:])/gu;
const SUFFIX_SEGMENT_PATTERN = /[-@:][^-@:]*/gu;
const RELEASE_SEGMENT_PATTERNS = [
  /^-\d{4}$/u,
  /^-\d{8}$/u,
  /^-latest$/u,
  /^-(?:minimal|low|medium|high|xhigh)$/u,
  /^@[a-z0-9.]+$/u,
  /^:\d+$/u,
  /^:latest$/u,
];
const BEDROCK_VERSION_SEGMENT_PATTERN = /^-v\d+$/u;
const BEDROCK_REVISION_SEGMENT_PATTERN = /^:\d+$/u;
// Claude prices extended thinking like any other output; other families (e.g.
// kimi-k2-thinking) ship -thinking as a separately priced model.
const CLAUDE_THINKING_SEGMENT = '-thinking';

function isReleaseSuffix(suffix: string, modelName: string): boolean {
  if (!/^[-@:]/u.test(suffix)) {
    return false;
  }

  const segments =
    suffix.replace(ISO_DATE_SEGMENT_PATTERN, '-$1$2$3').match(SUFFIX_SEGMENT_PATTERN) ?? [];

  return segments.every(
    (segment, index) =>
      RELEASE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)) ||
      (segment === CLAUDE_THINKING_SEGMENT &&
        stripProviderPrefix(modelName).startsWith('claude')) ||
      (BEDROCK_VERSION_SEGMENT_PATTERN.test(segment) &&
        BEDROCK_REVISION_SEGMENT_PATTERN.test(segments[index + 1] ?? '')),
  );
}

function isPrefixModelMatch(candidate: string, modelName: string): boolean {
  if (!candidate.startsWith(modelName)) {
    return false;
  }
  if (candidate.length === modelName.length) {
    return true;
  }
  return isReleaseSuffix(candidate.slice(modelName.length), modelName);
}

// Providers that publish their own list prices, then clouds that resell at list price.
// Everything else (aggregators, inference resellers) can carry markups or omit rates.
const FIRST_PARTY_PRICING_PROVIDERS = new Set([
  'anthropic',
  'cohere',
  'dashscope',
  'deepseek',
  'gemini',
  'minimax',
  'mistral',
  'moonshot',
  'openai',
  'perplexity',
  'xai',
  'zai',
]);
const CLOUD_PRICING_PROVIDERS = new Set(['azure', 'azure_ai', 'bedrock', 'vertex_ai']);

function getProviderPrefixedKeyRank(modelName: string, candidate: string): number {
  const prefix = modelName.slice(0, modelName.length - candidate.length - 1);
  const slashIndex = prefix.indexOf('/');

  if (slashIndex === -1 && modelName[prefix.length] === '.') {
    // Dotted keys (`anthropic.claude-…`, `zai.glm-…`) are Bedrock model ids.
    return 1;
  }

  const provider = slashIndex === -1 ? prefix : prefix.slice(0, slashIndex);

  if (FIRST_PARTY_PRICING_PROVIDERS.has(provider)) {
    return 0;
  }

  return CLOUD_PRICING_PROVIDERS.has(provider) ? 1 : 2;
}

function countDefinedRates(pricing: ModelPricing | undefined): number {
  if (!pricing) {
    return 0;
  }

  return [
    pricing.inputPer1MUsd,
    pricing.outputPer1MUsd,
    pricing.cacheReadPer1MUsd,
    pricing.cacheWritePer1MUsd,
  ].filter((rate) => rate !== undefined).length;
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
    const matches = [...pricingByModel.keys()].filter(
      (modelName) => modelName.endsWith(`/${candidate}`) || modelName.endsWith(`.${candidate}`),
    );
    if (matches.length === 0) {
      continue;
    }
    // Several hosts often price the same model: prefer the model's own provider, then
    // the key that defines the most rates, then the shortest key.
    return matches
      .map((modelName) => ({
        modelName,
        rank: getProviderPrefixedKeyRank(modelName, candidate),
        definedRates: countDefinedRates(pricingByModel.get(modelName)),
      }))
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          right.definedRates - left.definedRates ||
          left.modelName.length - right.modelName.length ||
          compareByCodePoint(left.modelName, right.modelName),
      )[0].modelName;
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
  const maxDistance = Math.max(2, Math.floor(fuzzyTarget.length * 0.2));
  let bestMatch: { modelName: string; distance: number } | undefined;
  for (const modelName of pricingByModel.keys()) {
    if (!areNumericSignaturesCompatible(strippedModel, modelName)) {
      continue;
    }
    const fuzzyModelName = canonicalizeForFuzzy(modelName);
    if (!fuzzyModelName) {
      continue;
    }
    // A length difference is a lower bound on edit distance, so skipping
    // here cannot change any match result.
    if (Math.abs(fuzzyTarget.length - fuzzyModelName.length) > maxDistance) {
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
