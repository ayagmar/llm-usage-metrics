import { isDeepStrictEqual } from 'node:util';

// One suffix of each kind the matcher folds back onto a priced name
// (`isReleaseSuffix` and `resolveEffortSuffixMatch` in litellm-model-matching.ts): short
// and long dates, ISO dates, -latest, effort labels, Vertex @versions, revisions, Claude's
// -thinking and Bedrock -vN:n.
const RELEASE_SUFFIX_PROBES = [
  '-0613',
  '-20250101',
  '-2025-01-01',
  '-latest',
  '-high',
  '@20250101',
  ':0',
  ':latest',
  '-thinking',
  '-v1:0',
];

/**
 * The names a harness may report that a pricing key can price: the key, its shorter
 * forms (`openrouter/anthropic/claude-sonnet-4.5` also prices `anthropic/claude-sonnet-4.5`
 * and `claude-sonnet-4.5`), and each of those with a release or effort suffix. A name with
 * an extra provider prefix (`eu/gpt-4o-realtime-preview`) resolves through its last
 * segment, so its prefix only matters when another key ends with it; probing the shorter
 * forms of every key covers those names. Misspellings that only fuzzy matching reaches
 * (`gpt-4.0314`) are not probed: they have no fixed set, so a pruned key can leave them
 * unpriced.
 *
 * @param {string} modelName
 * @returns {string[]}
 */
export function pricingProbeNames(modelName) {
  const names = [modelName];

  for (
    let index = modelName.indexOf('/');
    index !== -1;
    index = modelName.indexOf('/', index + 1)
  ) {
    names.push(modelName.slice(index + 1));
  }

  return names.flatMap((name) => [name, ...RELEASE_SUFFIX_PROBES.map((suffix) => name + suffix)]);
}

// Back-fills in the retired file's order, as the pricing fetcher does: fuzzy matching
// keeps the first of equally close keys.
function withRetiredPricing(livePricingByModel, retiredPricingByModel, keptModels) {
  const pricingByModel = new Map(livePricingByModel);

  for (const modelName of retiredPricingByModel.keys()) {
    if (keptModels.has(modelName) && !pricingByModel.has(modelName)) {
      pricingByModel.set(modelName, retiredPricingByModel.get(modelName));
    }
  }

  return pricingByModel;
}

/**
 * Names whose resolution can depend on the given keys. Each matcher step picks among the
 * keys that pass its filter, so when a name resolves to nothing against these keys alone,
 * none of them passes any step's filter, and adding them to other pricing leaves the
 * name's resolution unchanged.
 *
 * @param {Iterable<string>} names
 * @param {ReadonlyMap<string, object>} pricingByModel
 * @param {(modelName: string, pricingByModel: ReadonlyMap<string, object>) => string | undefined} resolveCanonicalModelKey
 * @returns {string[]}
 */
export function namesReachingPricing(names, pricingByModel, resolveCanonicalModelKey) {
  return [...names].filter((name) => resolveCanonicalModelKey(name, pricingByModel) !== undefined);
}

/**
 * Drops retired entries whose name the live pricing alone already resolves to the same
 * rates. The retired entries back-fill the live pricing before matching, so a dropped
 * entry can also change what another name resolves to. Each name that resolves to
 * different rates, or to none, gets back the entry it resolved to with every retired
 * entry present; the pruned pricing is a subset of that, so the same match wins again.
 * This repeats until every name from `pricingProbeNames`, for live and retired keys,
 * resolves as it did with every retired entry present. Keys are normalized pricing keys.
 *
 * @param {ReadonlyMap<string, object>} livePricingByModel
 * @param {ReadonlyMap<string, object>} retiredPricingByModel
 * @param {(modelName: string, pricingByModel: ReadonlyMap<string, object>) => string | undefined} resolveCanonicalModelKey
 * @returns {Map<string, object>} the retired entries to keep, in their original order
 */
export function pruneRetiredPricing(
  livePricingByModel,
  retiredPricingByModel,
  resolveCanonicalModelKey,
) {
  const resolveKey = (modelName, pricingByModel) =>
    resolveCanonicalModelKey(modelName, pricingByModel) ?? modelName;
  const retiredModels = [...retiredPricingByModel.keys()];
  const fullPricingByModel = withRetiredPricing(
    livePricingByModel,
    retiredPricingByModel,
    new Set(retiredModels),
  );
  const probeNames = new Set(
    [...livePricingByModel.keys(), ...retiredModels].flatMap(pricingProbeNames),
  );
  const fullMatchByName = new Map();
  const getFullMatch = (name) => {
    if (!fullMatchByName.has(name)) {
      const key = resolveKey(name, fullPricingByModel);
      fullMatchByName.set(name, { key, pricing: fullPricingByModel.get(key) });
    }

    return fullMatchByName.get(name);
  };
  const keptModels = new Set(
    retiredModels.filter(
      (modelName) =>
        !isDeepStrictEqual(
          livePricingByModel.get(resolveKey(modelName, livePricingByModel)),
          retiredPricingByModel.get(modelName),
        ),
    ),
  );

  for (;;) {
    const droppedPricingByModel = new Map(
      retiredModels
        .filter((modelName) => !keptModels.has(modelName))
        .map((modelName) => [modelName, retiredPricingByModel.get(modelName)]),
    );
    const prunedPricingByModel = withRetiredPricing(
      livePricingByModel,
      retiredPricingByModel,
      keptModels,
    );
    const missingKeys = namesReachingPricing(
      probeNames,
      droppedPricingByModel,
      resolveCanonicalModelKey,
    )
      .filter(
        (name) =>
          !isDeepStrictEqual(
            prunedPricingByModel.get(resolveKey(name, prunedPricingByModel)),
            getFullMatch(name).pricing,
          ),
      )
      .map((name) => getFullMatch(name).key);

    if (missingKeys.length === 0) {
      break;
    }

    if (missingKeys.every((key) => keptModels.has(key))) {
      throw new Error(`Pruning retired pricing keeps changing what resolves to ${missingKeys[0]}`);
    }

    for (const key of missingKeys) {
      keptModels.add(key);
    }
  }

  return new Map(
    retiredModels
      .filter((modelName) => keptModels.has(modelName))
      .map((modelName) => [modelName, retiredPricingByModel.get(modelName)]),
  );
}
