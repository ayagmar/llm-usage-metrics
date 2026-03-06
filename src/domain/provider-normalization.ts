import { compareByCodePoint } from '../utils/compare-by-code-point.js';

const billingProviderAliases = new Map<string, string>([
  ['openai-codex', 'openai'],
  ['github-copilot', 'github'],
]);

const billingProviderPrefixAliases: Array<[prefix: string, billingProvider: string]> = [
  ['openai-', 'openai'],
  ['openai/', 'openai'],
];

const knownCanonicalProviderRoots = new Set(['anthropic', 'github', 'google', 'openai']);

const explicitModelProviderRootPatterns: Array<[pattern: RegExp, providerRoot: string]> = [
  [/^gpt-/u, 'openai'],
  [/^o(?:1|3|4)(?:$|[-.])/u, 'openai'],
  [/^claude(?:$|[-.])/u, 'anthropic'],
  [/^gemini(?:$|[-.])/u, 'google'],
];

export function normalizeProviderToBillingEntity(provider: string | undefined): string | undefined {
  if (!provider) {
    return undefined;
  }

  const normalizedProvider = provider.trim().toLowerCase();

  if (normalizedProvider.length === 0) {
    return undefined;
  }

  const aliasedProvider = billingProviderAliases.get(normalizedProvider);

  if (aliasedProvider) {
    return aliasedProvider;
  }

  for (const [prefix, billingProvider] of billingProviderPrefixAliases) {
    if (normalizedProvider.startsWith(prefix)) {
      return billingProvider;
    }
  }

  return normalizedProvider;
}

export function matchesCanonicalProviderFilter(
  provider: string | undefined,
  providerFilter: string | undefined,
): boolean {
  if (!providerFilter) {
    return true;
  }

  const normalizedProvider = normalizeProviderToBillingEntity(provider);
  return normalizedProvider?.includes(providerFilter) ?? false;
}

export function collectCanonicalProviderRoots(providers: Iterable<string | undefined>): string[] {
  const canonicalProviders = new Set<string>();

  for (const provider of providers) {
    const normalizedProvider = normalizeProviderToBillingEntity(provider);

    if (normalizedProvider) {
      canonicalProviders.add(normalizedProvider);
    }
  }

  return [...canonicalProviders].sort(compareByCodePoint);
}

export function resolveExplicitProviderRoots(
  providerFilter: string | undefined,
): string[] | undefined {
  if (!providerFilter) {
    return undefined;
  }

  const normalizedProviderFilter = normalizeProviderToBillingEntity(providerFilter);

  if (!normalizedProviderFilter || !knownCanonicalProviderRoots.has(normalizedProviderFilter)) {
    return undefined;
  }

  return [normalizedProviderFilter];
}

function inferCanonicalProviderRootFromModel(model: string): string | undefined {
  const normalizedModel = model.trim().toLowerCase();

  if (!normalizedModel) {
    return undefined;
  }

  for (const [pattern, providerRoot] of explicitModelProviderRootPatterns) {
    if (pattern.test(normalizedModel)) {
      return providerRoot;
    }
  }

  return undefined;
}

export function inferCanonicalProviderRootsFromModels(
  models: string[] | undefined,
): string[] | undefined {
  if (!models || models.length === 0) {
    return undefined;
  }

  const inferredProviderRoots = new Set<string>();

  for (const model of models) {
    const inferredProviderRoot = inferCanonicalProviderRootFromModel(model);

    if (!inferredProviderRoot) {
      return undefined;
    }

    inferredProviderRoots.add(inferredProviderRoot);
  }

  return [...inferredProviderRoots].sort(compareByCodePoint);
}

export function intersectCanonicalProviderRoots(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const rightSet = new Set(right);
  return left.filter((providerRoot) => rightSet.has(providerRoot));
}
