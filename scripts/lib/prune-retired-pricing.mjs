import { isDeepStrictEqual } from 'node:util';

// A model name and the shorter names a harness may report for it: a retired
// `openrouter/anthropic/claude-sonnet-4.5` also prices `anthropic/claude-sonnet-4.5` and
// `claude-sonnet-4.5`.
function reportedNames(modelName) {
  const names = [modelName];

  for (
    let index = modelName.indexOf('/');
    index !== -1;
    index = modelName.indexOf('/', index + 1)
  ) {
    names.push(modelName.slice(index + 1));
  }

  return names;
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
 * Drops retired entries whose name the live pricing alone already resolves to the same
 * rates. The retired entries back-fill the live pricing before matching, so a dropped
 * entry can also change what another name resolves to. Each name that resolves to
 * different rates gets back the entry it resolved to with every retired entry present;
 * the pruned pricing is a subset of that, so the same match wins again. This repeats
 * until every retired name, and every shorter name it may be reported as, resolves to
 * its old rates. Keys are normalized pricing keys.
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
  const fullMatches = retiredModels.flatMap(reportedNames).map((name) => {
    const key = resolveKey(name, fullPricingByModel);
    return { name, key, pricing: fullPricingByModel.get(key) };
  });
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
    const prunedPricingByModel = withRetiredPricing(
      livePricingByModel,
      retiredPricingByModel,
      keptModels,
    );
    const missingKeys = fullMatches
      .filter(
        ({ name, pricing }) =>
          !isDeepStrictEqual(
            prunedPricingByModel.get(resolveKey(name, prunedPricingByModel)),
            pricing,
          ),
      )
      .map(({ key }) => key);

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
