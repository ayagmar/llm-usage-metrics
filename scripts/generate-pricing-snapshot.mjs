#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tsImport } from 'tsx/esm/api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const snapshotPath = join(rootDir, 'src', 'pricing', 'litellm-pricing-snapshot.json');

const {
  DEFAULT_LITELLM_PRICING_URL,
  MAX_LITELLM_PRICING_RESPONSE_BYTES,
  normalizeLiteLLMCachePayload,
  normalizeLitellmPricingPayload,
} = await tsImport(join(rootDir, 'src', 'pricing', 'litellm-pricing-fetcher.ts'), import.meta.url);

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

  if (pricing.reasoningPer1MUsd !== undefined) {
    orderedPricing.reasoningPer1MUsd = pricing.reasoningPer1MUsd;
    orderedPricing.reasoningBilling = 'separate';
  }

  return orderedPricing;
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

async function generateSnapshot() {
  const response = await fetch(DEFAULT_LITELLM_PRICING_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch LiteLLM pricing: HTTP ${response.status}`);
  }

  const payload = await readJsonWithByteLimit(response);
  const pricingByModel = normalizeLitellmPricingPayload(payload);
  const snapshotPayload = {
    fetchedAt: Date.now(),
    sourceUrl: DEFAULT_LITELLM_PRICING_URL,
    pricingByModel: toSortedPricingRecord(pricingByModel),
  };
  const { modelCount, fetchedAt } = assertSnapshotPayload(snapshotPayload);

  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshotPayload, null, 2)}\n`, 'utf8');

  console.log(
    `Wrote ${snapshotPath}: ${modelCount} model(s), fetched ${new Date(fetchedAt).toISOString()}`,
  );
}

if (process.argv.includes('--check')) {
  await checkSnapshot();
} else {
  await generateSnapshot();
}
