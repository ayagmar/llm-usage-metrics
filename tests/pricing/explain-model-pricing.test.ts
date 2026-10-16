import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { resolvePricingSource } from '../../src/cli/build-usage-data-pricing.js';
import { getPricingFetcherRuntimeConfig } from '../../src/config/runtime-overrides.js';
import { explainModelPricing } from '../../src/pricing/explain-model-pricing.js';
import {
  explainCanonicalModelKey,
  normalizeKey,
  resolveCanonicalModelKey,
} from '../../src/pricing/litellm-model-matching.js';
import {
  DEFAULT_LITELLM_PRICING_URL,
  LiteLLMPricingFetcher,
} from '../../src/pricing/litellm-pricing-fetcher.js';
import litellmPricingSnapshot from '../../src/pricing/litellm-pricing-snapshot.json' with { type: 'json' };
import litellmRetiredPricing from '../../src/pricing/litellm-retired-pricing.json' with { type: 'json' };
import { PricingOverrideSource } from '../../src/pricing/pricing-override-source.js';
import type {
  CanonicalModelKeyExplanation,
  ModelPricing,
  PricingSource,
} from '../../src/pricing/types.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const overridesPath = path.resolve('tests/fixtures/pricing/explain-overrides.json');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'explain-model-pricing-'));
  tempDirs.push(dir);
  return dir;
}

const snapshotKeys = Object.keys(litellmPricingSnapshot.pricingByModel);
const retiredKeys = Object.keys(litellmRetiredPricing.pricingByModel);

/** The model names of the resolution reference table, read from that test file as is. */
async function readReferenceModelNames(): Promise<string[]> {
  const text = await readFile(
    path.resolve('tests/pricing/model-resolution-reference.test.ts'),
    'utf8',
  );
  return [...text.matchAll(/^\s*\['([^']+)', (?:'[^']*'|null)\],$/gmu)].map((match) => match[1]);
}

async function readOverrideNames(): Promise<string[]> {
  const payload = JSON.parse(await readFile(overridesPath, 'utf8')) as { models: object };
  return Object.keys(payload.models);
}

/** Snapshot keys first, then retired keys LiteLLM no longer lists, as the fetcher loads them. */
function loadMatcherPricing(): Map<string, ModelPricing> {
  const pricingByModel = new Map<string, ModelPricing>();

  for (const [name, pricing] of [
    ...Object.entries(litellmPricingSnapshot.pricingByModel),
    ...Object.entries(litellmRetiredPricing.pricingByModel),
  ]) {
    const key = normalizeKey(name);

    if (!pricingByModel.has(key)) {
      pricingByModel.set(key, pricing as ModelPricing);
    }
  }

  return pricingByModel;
}

/** What each rule says about the key, checked against the name it explains. */
function expectRuleHolds(normalizedModel: string, match: CanonicalModelKeyExplanation): void {
  const matched = match.strippedModel ?? match.canonicalModel ?? normalizedModel;

  switch (match.rule) {
    case 'preferred-key':
      expect(match.canonicalModel).toBeDefined();
      break;
    case 'direct':
      expect(match.key).toBe(matched);
      break;
    case 'effort-suffix':
      expect(match.canonicalModel).toBeUndefined();
      expect(match.key).toBe(matched);
      expect(normalizedModel).toMatch(/-(?:minimal|low|medium|high|xhigh)$/u);
      break;
    case 'provider-prefixed':
      expect(match.key.endsWith(`/${matched}`) || match.key.endsWith(`.${matched}`)).toBe(true);
      break;
    case 'release-suffix':
      expect(matched.startsWith(match.key)).toBe(true);
      expect(matched).not.toBe(match.key);
      break;
    case 'fuzzy':
      expect(match.fuzzyDistance).toBeTypeOf('number');
      break;
  }

  if (match.rule !== 'fuzzy') {
    expect(match.fuzzyDistance).toBeUndefined();
  }
}

describe('explaining a name through the composed pricing source', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();
  let source: PricingSource;
  let names: string[];

  beforeAll(async () => {
    ({ source } = await resolvePricingSource(
      { pricingOffline: true, pricingOverrides: overridesPath },
      getPricingFetcherRuntimeConfig(),
    ));
    const referenceNames = await readReferenceModelNames();
    const overrideNames = await readOverrideNames();
    // Spellings that reach the matcher in other forms: case, padding, aliases of overrides.
    const variants = [...referenceNames, ...overrideNames].flatMap((name) => [
      name.toUpperCase(),
      `  ${name} `,
      `${name}-thinking`,
    ]);
    names = [...snapshotKeys, ...retiredKeys, ...referenceNames, ...overrideNames, ...variants];

    expect(referenceNames.length).toBeGreaterThan(40);
  });

  it('explains the key and pricing the cost engine applies to every name', () => {
    for (const name of names) {
      const explanation = explainModelPricing(source, name);
      const resolvedModel = source.resolveModelAlias(name);
      const pricing = source.getPricing(resolvedModel);

      expect(explanation.pricingKey, name).toBe(pricing ? resolvedModel : null);
      expect(source.explainModel?.(name).pricing, name).toEqual(pricing);
      expect(explanation.rates === null, name).toBe(pricing === undefined);
    }
  }, 30_000);

  it('matches the key the matcher resolves, by a rule that holds for it', () => {
    const pricingByModel = loadMatcherPricing();

    for (const name of names) {
      const normalizedModel = normalizeKey(name);
      const match = explainCanonicalModelKey(normalizedModel, pricingByModel);

      expect(match?.key, name).toBe(resolveCanonicalModelKey(normalizedModel, pricingByModel));

      if (match) {
        expect(pricingByModel.has(match.key), name).toBe(true);
        expectRuleHolds(normalizedModel, match);
      }
    }
  }, 30_000);

  it('reports which override applies', () => {
    expect(explainModelPricing(source, 'ACME-internal-model')).toMatchObject({
      pricingKey: 'ACME-internal-model',
      override: 'raw',
      rule: null,
      origin: null,
      rates: { inputPer1MUsd: 1, outputPer1MUsd: 2, cacheReadPer1MUsd: 0.1 },
    });
    // The override is keyed on the key the alias resolves to.
    expect(explainModelPricing(source, 'claude-opus-4-8-thinking')).toMatchObject({
      pricingKey: 'claude-opus-4-8',
      override: 'resolved',
      rule: 'release-suffix',
      origin: null,
      retired: false,
      rates: { inputPer1MUsd: 12, reasoningPer1MUsd: 70, reasoningBilling: 'separate' },
    });
    expect(explainModelPricing(source, 'gpt-5.4')).toMatchObject({
      override: 'none',
      origin: { kind: 'bundled-snapshot', url: DEFAULT_LITELLM_PRICING_URL },
    });
  });

  it('flags only keys back-filled from retired prices', () => {
    const retiredOnly = retiredKeys.find(
      (key) => !(key in litellmPricingSnapshot.pricingByModel) && source.getPricing(key),
    );

    expect(retiredOnly).toBeDefined();
    expect(explainModelPricing(source, retiredOnly ?? '').retired).toBe(true);
    expect(explainModelPricing(source, snapshotKeys[0]).retired).toBe(false);
  });
});

describe('LiteLLMPricingFetcher explanations', () => {
  const payload = {
    'gpt-5.2': { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 },
  };

  it('names the network fetch and its time, and back-fills no retired prices for a custom URL', async () => {
    const rootDir = await createTempDir();
    const fetcher = new LiteLLMPricingFetcher({
      sourceUrl: 'https://example.test/pricing.json',
      cacheFilePath: path.join(rootDir, 'cache.json'),
      now: () => Date.UTC(2026, 5, 1),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    });

    await fetcher.load();

    expect(fetcher.explainModel('gpt-5.2-2026-01-01')).toMatchObject({
      resolvedModel: 'gpt-5.2',
      match: { key: 'gpt-5.2', rule: 'release-suffix' },
      origin: {
        kind: 'network',
        fetchedAt: Date.UTC(2026, 5, 1),
        url: 'https://example.test/pricing.json',
      },
      retired: false,
    });
    expect(fetcher.getPricing(retiredKeys[0])).toBeUndefined();
  });

  it('names the cache and the time it was fetched', async () => {
    const rootDir = await createTempDir();
    const cacheFilePath = path.join(rootDir, 'cache.json');
    const fetchedAt = Date.UTC(2026, 4, 1);
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        formatVersion: 3,
        fetchedAt,
        sourceUrl: DEFAULT_LITELLM_PRICING_URL,
        pricingByModel: { 'gpt-5.2': { inputPer1MUsd: 1.25, outputPer1MUsd: 10 } },
      }),
    );
    const fetcher = new LiteLLMPricingFetcher({
      cacheFilePath,
      offline: true,
      now: () => fetchedAt + 1000,
    });

    await fetcher.load();
    const explanation = fetcher.explainModel('gpt-5.2');

    expect(explanation.origin).toEqual({
      kind: 'cache',
      fetchedAt,
      url: DEFAULT_LITELLM_PRICING_URL,
    });
    expect(explanation.pricing).toEqual({ inputPer1MUsd: 1.25, outputPer1MUsd: 10 });
    // The default source back-fills retired prices behind the cache.
    expect(fetcher.explainModel(retiredKeys[0]).retired).toBe(true);
  });

  it('leaves an unmatched name unpriced, with no rule', async () => {
    const rootDir = await createTempDir();
    const fetcher = new LiteLLMPricingFetcher({
      sourceUrl: 'https://example.test/pricing.json',
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    });

    await fetcher.load();

    expect(fetcher.explainModel('  Totally-Unrelated ')).toEqual({
      normalizedModel: 'totally-unrelated',
      resolvedModel: 'totally-unrelated',
      override: 'none',
      origin: expect.objectContaining({ kind: 'network' }) as unknown,
      retired: false,
    });
  });
});

describe('PricingOverrideSource explanations', () => {
  const basePricing: ModelPricing = { inputPer1MUsd: 3, outputPer1MUsd: 15 };
  const overridePricing: ModelPricing = { inputPer1MUsd: 1, outputPer1MUsd: 2 };
  /** A delegate that cannot explain: it resolves `x-latest` to `x`. */
  const plainDelegate: PricingSource = {
    resolveModelAlias: (model) =>
      model
        .trim()
        .toLowerCase()
        .replace(/-latest$/u, ''),
    getPricing: (model) => (model === 'base-model' ? basePricing : undefined),
  };

  it('explains a delegate without explanations from its alias and pricing', () => {
    const source = new PricingOverrideSource(new Map([['custom', overridePricing]]), plainDelegate);

    expect(source.explainModel(' Base-Model-latest')).toEqual({
      normalizedModel: 'base-model-latest',
      resolvedModel: 'base-model',
      override: 'none',
      retired: false,
      pricing: basePricing,
    });
    expect(source.explainModel('Custom')).toEqual({
      normalizedModel: 'custom',
      resolvedModel: 'Custom',
      override: 'raw',
      retired: false,
      pricing: overridePricing,
    });
  });

  it('applies an override keyed on the resolved key to an alias of it', () => {
    const source = new PricingOverrideSource(
      new Map([['base-model', overridePricing]]),
      plainDelegate,
    );

    expect(source.explainModel('base-model-latest')).toMatchObject({
      resolvedModel: 'base-model',
      override: 'resolved',
      pricing: overridePricing,
    });
  });

  it('refuses a source that cannot explain its prices', () => {
    expect(() => explainModelPricing(plainDelegate, 'base-model')).toThrow(
      'This pricing source cannot explain its prices',
    );
  });
});
