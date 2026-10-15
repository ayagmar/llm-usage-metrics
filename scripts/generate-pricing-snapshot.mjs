#!/usr/bin/env node

import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';
import { tsImport } from 'tsx/esm/api';

import { pruneRetiredPricing } from './lib/prune-retired-pricing.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const snapshotPath = join(rootDir, 'src', 'pricing', 'litellm-pricing-snapshot.json');
const retiredPricingPath = join(rootDir, 'src', 'pricing', 'litellm-retired-pricing.json');
const modelMapPath = join(rootDir, 'src', 'pricing', 'litellm-model-map.json');

const {
  DEFAULT_LITELLM_PRICING_URL,
  MAX_LITELLM_PRICING_RESPONSE_BYTES,
  isLiteLLMTierRateKey,
  normalizeLiteLLMCachePayload,
  normalizeLitellmPricingPayload,
} = await tsImport(join(rootDir, 'src', 'pricing', 'litellm-pricing-fetcher.ts'), import.meta.url);
const { resolveCanonicalModelKey } = await tsImport(
  join(rootDir, 'src', 'pricing', 'litellm-model-matching.ts'),
  import.meta.url,
);

function compareByCodePoint(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function orderModelPricing(pricing) {
  const orderedPricing = {
    inputPer1MUsd: pricing.inputPer1MUsd,
    outputPer1MUsd: pricing.outputPer1MUsd,
  };

  if (pricing.cacheReadPer1MUsd !== undefined) {
    orderedPricing.cacheReadPer1MUsd = pricing.cacheReadPer1MUsd;
  }

  if (pricing.cacheWritePer1MUsd !== undefined) {
    orderedPricing.cacheWritePer1MUsd = pricing.cacheWritePer1MUsd;
  }

  if (pricing.cacheWrite1hPer1MUsd !== undefined) {
    orderedPricing.cacheWrite1hPer1MUsd = pricing.cacheWrite1hPer1MUsd;
  }

  if (pricing.reasoningPer1MUsd !== undefined) {
    orderedPricing.reasoningPer1MUsd = pricing.reasoningPer1MUsd;
    orderedPricing.reasoningBilling = 'separate';
  }

  if (pricing.priorityFallback !== undefined) {
    orderedPricing.priorityFallback = [...pricing.priorityFallback];
  }

  if (pricing.tiers !== undefined) {
    orderedPricing.tiers = pricing.tiers.map(orderPricingTier);
  }

  return orderedPricing;
}

const TIER_RATE_FIELDS = [
  'inputPer1MUsd',
  'outputPer1MUsd',
  'cacheReadPer1MUsd',
  'cacheWritePer1MUsd',
  'cacheWrite1hPer1MUsd',
];

function orderPricingTier(tier) {
  const orderedTier = { aboveTokens: tier.aboveTokens };

  for (const field of TIER_RATE_FIELDS) {
    if (tier[field] !== undefined) {
      orderedTier[field] = tier[field];
    }
  }

  return orderedTier;
}

// Threshold keys the tiers do not carry: service-tier variants (`_batches`, `_priority`,
// ...) and per-character, image, audio or video rates. List them so a new standard key
// upstream gets noticed.
function logUnusedThresholdKeys(payload) {
  const modelCountByKey = new Map();

  for (const rawModelPricing of Object.values(payload)) {
    if (rawModelPricing === null || typeof rawModelPricing !== 'object') {
      continue;
    }

    for (const key of Object.keys(rawModelPricing)) {
      if (/_above_\d+k_tokens/u.test(key) && !isLiteLLMTierRateKey(key)) {
        modelCountByKey.set(key, (modelCountByKey.get(key) ?? 0) + 1);
      }
    }
  }

  if (modelCountByKey.size === 0) {
    return;
  }

  console.log(`Token-threshold keys not used for tiers (${modelCountByKey.size}):`);

  for (const [key, modelCount] of [...modelCountByKey].sort(([left], [right]) =>
    compareByCodePoint(left, right),
  )) {
    console.log(`  - ${key} (${modelCount} model(s))`);
  }
}

// Prettier keeps short arrays (such as `priorityFallback`) on one line, so a regenerated
// file passes `format:check` as written.
async function writeJsonFile(filePath, payload) {
  const options = { ...(await resolveConfig(filePath)), filepath: filePath };
  await writeFile(filePath, await format(JSON.stringify(payload, null, 2), options), 'utf8');
}

function toSortedPricingRecord(pricingByModel) {
  const entries = [...pricingByModel.entries()].sort(([leftModel], [rightModel]) =>
    compareByCodePoint(leftModel, rightModel),
  );

  return Object.fromEntries(
    entries.map(([modelName, pricing]) => [modelName, orderModelPricing(pricing)]),
  );
}

async function readJsonWithByteLimit(response) {
  const contentLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(contentLength) && contentLength > MAX_LITELLM_PRICING_RESPONSE_BYTES) {
    throw new Error(
      `LiteLLM pricing response exceeds ${MAX_LITELLM_PRICING_RESPONSE_BYTES} bytes (content-length ${contentLength})`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const payloadBuffer = Buffer.from(arrayBuffer);

  if (payloadBuffer.byteLength > MAX_LITELLM_PRICING_RESPONSE_BYTES) {
    throw new Error(`LiteLLM pricing response exceeds ${MAX_LITELLM_PRICING_RESPONSE_BYTES} bytes`);
  }

  return JSON.parse(payloadBuffer.toString('utf8'));
}

function assertSnapshotPayload(payload) {
  const normalizedPayload = normalizeLiteLLMCachePayload(payload);

  if (!normalizedPayload) {
    throw new Error('Snapshot is not a valid LiteLLM cache payload');
  }

  if (normalizedPayload.sourceUrl !== DEFAULT_LITELLM_PRICING_URL) {
    throw new Error(
      `Snapshot sourceUrl must be ${DEFAULT_LITELLM_PRICING_URL}, received ${normalizedPayload.sourceUrl}`,
    );
  }

  const modelCount = Object.keys(normalizedPayload.pricingByModel).length;

  if (modelCount === 0) {
    throw new Error('Snapshot does not contain any usable model pricing entries');
  }

  if (!Number.isFinite(normalizedPayload.fetchedAt) || normalizedPayload.fetchedAt <= 0) {
    throw new Error('Snapshot fetchedAt must be a positive epoch-millisecond timestamp');
  }

  return { modelCount, fetchedAt: normalizedPayload.fetchedAt };
}

async function checkSnapshot() {
  const snapshotContent = await readFile(snapshotPath, 'utf8');
  const payload = JSON.parse(snapshotContent);
  const { modelCount, fetchedAt } = assertSnapshotPayload(payload);

  console.log(
    `Pricing snapshot OK: ${modelCount} model(s), fetched ${new Date(fetchedAt).toISOString()}`,
  );
}

async function readPricingRecord(filePath) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    return payload.pricingByModel ?? {};
  } catch {
    return {};
  }
}

// LiteLLM drops retired models, but their prices still apply to historical usage. Keys
// that leave upstream move from the snapshot into the retired-pricing file and stay there
// until upstream lists them again, unless the live pricing already resolves them (and
// the shorter names they may be reported as) to the same rates.
async function writeRetiredPricing(upstreamPricingByModel) {
  const previousRetiredPricing = await readPricingRecord(retiredPricingPath);
  const previousSnapshotPricing = await readPricingRecord(snapshotPath);
  const previousPricing = { ...previousRetiredPricing, ...previousSnapshotPricing };
  const leftUpstreamPricing = new Map(
    Object.entries(previousPricing)
      .filter(([modelName]) => !upstreamPricingByModel.has(modelName))
      .sort(([left], [right]) => compareByCodePoint(left, right)),
  );
  const retiredPricing = pruneRetiredPricing(
    upstreamPricingByModel,
    leftUpstreamPricing,
    resolveCanonicalModelKey,
  );
  const newlyRetiredModels = Object.keys(previousSnapshotPricing)
    .filter((modelName) => !upstreamPricingByModel.has(modelName))
    .sort(compareByCodePoint);

  // A refresh is a pricing change, not a chore: list what left upstream so the diff gets
  // reviewed, and check that the model map's preferred keys still exist.
  if (newlyRetiredModels.length > 0) {
    console.log(`Models removed upstream since the last snapshot (${newlyRetiredModels.length}):`);

    for (const modelName of newlyRetiredModels) {
      console.log(`  - ${modelName}`);
    }
  }

  const modelMap = JSON.parse(await readFile(modelMapPath, 'utf8'));
  const missingPreferredKeys = Object.entries(modelMap.preferredPricingKeyByCanonicalModel ?? {})
    .filter(([, pricingKey]) => !upstreamPricingByModel.has(pricingKey))
    .map(([canonicalModel, pricingKey]) => `${canonicalModel} -> ${pricingKey}`);

  if (missingPreferredKeys.length > 0) {
    console.warn('Preferred pricing keys missing upstream; update litellm-model-map.json:');

    for (const entry of missingPreferredKeys) {
      console.warn(`  - ${entry}`);
    }
  }

  await writeJsonFile(retiredPricingPath, {
    pricingByModel: toSortedPricingRecord(retiredPricing),
  });

  return { kept: retiredPricing.size, pruned: leftUpstreamPricing.size - retiredPricing.size };
}

async function fetchUpstreamPayload() {
  const response = await fetch(DEFAULT_LITELLM_PRICING_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch LiteLLM pricing: HTTP ${response.status}`);
  }

  return { payload: await readJsonWithByteLimit(response), fetchedAt: Date.now() };
}

// `--from <file>` regenerates from a saved copy of the upstream JSON, so a refresh can be
// repeated against the same input. The file's mtime stands in for the fetch time.
async function readUpstreamPayloadFromFile(filePath) {
  const fileStat = await stat(filePath);

  if (fileStat.size > MAX_LITELLM_PRICING_RESPONSE_BYTES) {
    throw new Error(`${filePath} exceeds ${MAX_LITELLM_PRICING_RESPONSE_BYTES} bytes`);
  }

  return {
    payload: JSON.parse(await readFile(filePath, 'utf8')),
    fetchedAt: Math.trunc(fileStat.mtimeMs),
  };
}

function readFromOption() {
  const index = process.argv.indexOf('--from');

  if (index === -1) {
    return undefined;
  }

  const filePath = process.argv[index + 1];

  if (!filePath || filePath.startsWith('--')) {
    throw new Error('--from needs a path to a LiteLLM model_prices_and_context_window.json file');
  }

  return filePath;
}

async function generateSnapshot(fromFilePath) {
  const { payload, fetchedAt: upstreamFetchedAt } = fromFilePath
    ? await readUpstreamPayloadFromFile(fromFilePath)
    : await fetchUpstreamPayload();
  const pricingByModel = normalizeLitellmPricingPayload(payload);
  logUnusedThresholdKeys(payload);
  const snapshotPayload = {
    fetchedAt: upstreamFetchedAt,
    sourceUrl: DEFAULT_LITELLM_PRICING_URL,
    pricingByModel: toSortedPricingRecord(pricingByModel),
  };
  const { modelCount, fetchedAt } = assertSnapshotPayload(snapshotPayload);

  await mkdir(dirname(snapshotPath), { recursive: true });
  const retiredCounts = await writeRetiredPricing(pricingByModel);
  await writeJsonFile(snapshotPath, snapshotPayload);

  console.log(
    `Wrote ${snapshotPath}: ${modelCount} model(s), fetched ${new Date(fetchedAt).toISOString()}; ${retiredCounts.kept} retired model(s) kept, ${retiredCounts.pruned} already priced the same by live keys`,
  );
}

if (process.argv.includes('--check')) {
  await checkSnapshot();
} else {
  await generateSnapshot(readFromOption());
}
