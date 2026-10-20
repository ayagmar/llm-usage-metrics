import type * as NodeFsPromises from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUsageRecord } from '../../src/domain/session-event.js';
import { createUsageEvent, type UsageEventInput } from '../../src/domain/usage-event.js';
import { LiteLLMPricingFetcher } from '../../src/pricing/litellm-pricing-fetcher.js';
import {
  createPricingSource,
  estimateEventCostUsd,
  explainModelPricing,
  fetchLiteLLMPricing,
  loadBundledPricing,
  priceEvents,
  withOverrides,
  type ModelPricing,
} from '../../src/pricing/index.js';
import { noNetworkFetch } from '../helpers/no-network.js';

// A model only the bundled retired prices list.
const RETIRED_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

function event(overrides: Partial<UsageEventInput> = {}) {
  return createUsageEvent({
    source: 'pi',
    sessionId: 'session-1',
    timestamp: '2026-02-16T10:00:00Z',
    model: 'gpt-5',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    ...overrides,
  });
}

function stubFetchServing(payload: object) {
  const fetchStub = vi.fn((_url: string, init?: RequestInit) =>
    init?.signal?.aborted
      ? Promise.reject(init.signal.reason as Error)
      : Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
});

describe('loadBundledPricing', () => {
  it('prices like the CLI offline fetcher, without the network', async () => {
    const fetchSpy = vi.fn(noNetworkFetch);
    vi.stubGlobal('fetch', fetchSpy);
    const fetcher = new LiteLLMPricingFetcher({
      offline: true,
      cacheFilePath: '/nonexistent/llm-usage-metrics-library-cache.json',
      fetchImpl: noNetworkFetch,
    });
    await fetcher.load();

    const source = await loadBundledPricing();

    for (const model of [
      'claude-sonnet-4-5-20250929',
      'gpt-5-codex',
      'gemini-2.5-pro',
      RETIRED_MODEL,
      'no-such-model',
    ]) {
      expect(explainModelPricing(source, model)).toEqual(explainModelPricing(fetcher, model));
      expect(source.getMaxInputTokens?.(model)).toBe(fetcher.getMaxInputTokens(model));
    }
    expect(explainModelPricing(source, RETIRED_MODEL)).toMatchObject({
      retired: true,
      origin: { kind: 'bundled-snapshot' },
    });
    expect(source.getMaxInputTokens?.('claude-sonnet-4-5')).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads the data files on the first call only, not at import', async () => {
    const dataReads: string[] = [];
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof NodeFsPromises>();
      const readFile = ((file: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
        dataReads.push(file instanceof URL ? file.pathname : typeof file === 'string' ? file : '?');
        return (actual.readFile as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof actual.readFile;
      return { ...actual, readFile, default: { ...actual, readFile } };
    });
    vi.resetModules();

    // eslint-disable-next-line no-restricted-syntax -- importing after the mock is what is tested
    const pricing = await import('../../src/pricing/index.js');
    expect(dataReads).toEqual([]);

    const [first, second] = await Promise.all([
      pricing.loadBundledPricing(),
      pricing.loadBundledPricing(),
    ]);
    const third = await pricing.loadBundledPricing();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(dataReads.map((file) => file.slice(file.lastIndexOf('/') + 1)).sort()).toEqual([
      'litellm-context-limits.json',
      'litellm-pricing-snapshot.json',
      'litellm-retired-pricing.json',
    ]);
  });

  it('reads the data files again after a failed first read', async () => {
    let failNextRead = true;
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof NodeFsPromises>();
      const readFile = ((...args: Parameters<typeof actual.readFile>) => {
        if (failNextRead) {
          failNextRead = false;
          return Promise.reject(
            Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
          );
        }
        return actual.readFile(...args);
      }) as typeof actual.readFile;
      return { ...actual, readFile, default: { ...actual, readFile } };
    });
    vi.resetModules();

    // eslint-disable-next-line no-restricted-syntax -- importing after the mock is what is tested
    const pricing = await import('../../src/pricing/index.js');

    await expect(pricing.loadBundledPricing()).rejects.toThrow(/EMFILE/u);
    const source = await pricing.loadBundledPricing();
    expect(source.getPricing(source.resolveModelAlias('claude-sonnet-4-5'))).toBeDefined();
  });
});

describe('priceEvents', () => {
  const source = createPricingSource(
    new Map<string, ModelPricing>([['gpt-5', { inputPer1MUsd: 1, outputPer1MUsd: 2 }]]),
  );

  it('keeps logged costs and estimates the rest by default', () => {
    const logged = event({ costUsd: 0.5 });
    const unlogged = event();

    const [pricedLogged, pricedUnlogged] = priceEvents([logged, unlogged], source);

    expect(pricedLogged).toMatchObject({ costUsd: 0.5, costMode: 'explicit' });
    expect(pricedUnlogged).toMatchObject({ costUsd: 3, costMode: 'estimated' });
    expect(logged).not.toHaveProperty('costMode');
    expect(unlogged.costUsd).toBeUndefined();
  });

  it('keeps the fields and type of the events it prices', () => {
    const record = createUsageRecord({
      source: 'pi',
      sessionId: 'session-1',
      timestamp: '2026-02-16T10:00:00Z',
      model: 'gpt-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      rawProvider: 'openai',
    });

    const [priced] = priceEvents([record], source);

    // Compiles only while the result keeps the record's own fields.
    const kind: 'usage' = priced.kind;
    expect(kind).toBe('usage');
    expect(priced.rawProvider).toBe('openai');
    expect(priced.costUsd).toBe(3);
  });

  it('applies the cost modes', () => {
    const events = [event({ costUsd: 0.5 }), event()];

    expect(
      priceEvents(events, source, { costMode: 'estimated' }).map((priced) => priced.costUsd),
    ).toEqual([3, 3]);
    expect(
      priceEvents(events, source, { costMode: 'explicit' }).map((priced) => priced.costUsd),
    ).toEqual([0.5, undefined]);
  });

  it('leaves an unknown model without a cost', () => {
    const [priced] = priceEvents([event({ model: 'no-such-model' })], source);

    expect(priced.costUsd).toBeUndefined();
    expect(priced.costMode).toBe('estimated');
  });

  it('bills a single request above a long-context threshold at the tier rates', () => {
    const tiered = createPricingSource(
      new Map<string, ModelPricing>([
        [
          'gpt-5',
          {
            inputPer1MUsd: 1,
            outputPer1MUsd: 2,
            tiers: [{ aboveTokens: 200_000, inputPer1MUsd: 2, outputPer1MUsd: 4 }],
          },
        ],
      ]),
    );

    const [single, summed] = priceEvents(
      [event({ singleRequest: true }), event({ singleRequest: false })],
      tiered,
    );

    expect(single.costUsd).toBe(6);
    expect(summed.costUsd).toBe(3);
  });
});

describe('estimateEventCostUsd', () => {
  it('is undefined when the pricing lacks a rate for a bucket the event used', () => {
    const pricing: ModelPricing = { inputPer1MUsd: 1, outputPer1MUsd: 2 };

    expect(estimateEventCostUsd(event(), pricing)).toBe(3);
    expect(estimateEventCostUsd(event({ cacheReadTokens: 10 }), pricing)).toBeUndefined();
  });
});

describe('createPricingSource and withOverrides', () => {
  it('resolves names to your keys with the bundled matcher', () => {
    const source = createPricingSource(
      new Map<string, ModelPricing>([['My-Model', { inputPer1MUsd: 1, outputPer1MUsd: 2 }]]),
      {
        maxInputTokensByModel: new Map([['my-model', 128_000]]),
        origin: { kind: 'network', fetchedAt: 0, url: 'https://example.test/rates.json' },
      },
    );

    expect(source.resolveModelAlias('my-model-20260101')).toBe('my-model');
    expect(source.getPricing('MY-MODEL')).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 2 });
    expect(source.getMaxInputTokens?.('my-model-20260101')).toBe(128_000);
    expect(explainModelPricing(source, 'my-model').origin?.url).toBe(
      'https://example.test/rates.json',
    );
  });

  it('prices an overridden name and the names that resolve to it from the overrides', () => {
    const base = createPricingSource(
      new Map<string, ModelPricing>([
        ['my-model', { inputPer1MUsd: 1, outputPer1MUsd: 2 }],
        ['other-model', { inputPer1MUsd: 3, outputPer1MUsd: 4 }],
      ]),
    );
    const override: ModelPricing = { inputPer1MUsd: 10, outputPer1MUsd: 20 };
    const source = withOverrides(base, new Map([['My-Model', override]]));

    expect(source.getPricing(source.resolveModelAlias('my-model'))).toEqual(override);
    expect(source.getPricing(source.resolveModelAlias('my-model-20260101'))).toEqual(override);
    expect(source.getPricing(source.resolveModelAlias('other-model'))).toEqual({
      inputPer1MUsd: 3,
      outputPer1MUsd: 4,
    });
    expect(explainModelPricing(source, 'my-model').override).toBe('raw');
  });

  it('rejects rates that would make costs NaN or negative', () => {
    const base = createPricingSource(new Map());
    const invalid: ModelPricing[] = [
      { inputPer1MUsd: Number.NaN, outputPer1MUsd: 2 },
      { inputPer1MUsd: 1, outputPer1MUsd: 2, cacheReadPer1MUsd: -1 },
      { inputPer1MUsd: 1, outputPer1MUsd: 2, tiers: [{ aboveTokens: 200_000, inputPer1MUsd: -2 }] },
    ];

    for (const pricing of invalid) {
      const rates = new Map([['my-model', pricing]]);
      expect(() => createPricingSource(rates)).toThrow(/Invalid pricing for "my-model"/u);
      expect(() => withOverrides(base, rates)).toThrow(/Invalid pricing for "my-model"/u);
    }
  });
});

describe('fetchLiteLLMPricing', () => {
  const payload = {
    'my-model': {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      max_input_tokens: 64_000,
    },
  };

  it('prices from the fetched JSON, with no retired prices from another URL', async () => {
    const fetchStub = stubFetchServing(payload);

    const source = await fetchLiteLLMPricing({ url: 'https://example.test/prices.json' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe('https://example.test/prices.json');
    expect(source.getPricing('my-model')).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 2 });
    expect(source.getMaxInputTokens?.('my-model')).toBe(64_000);
    expect(source.getPricing(source.resolveModelAlias(RETIRED_MODEL))).toBeUndefined();
    expect(explainModelPricing(source, 'my-model').origin).toMatchObject({
      kind: 'network',
      url: 'https://example.test/prices.json',
    });
  });

  it('back-fills the bundled retired prices from the default URL', async () => {
    const fetchStub = stubFetchServing(payload);

    const source = await fetchLiteLLMPricing();

    expect(fetchStub.mock.calls[0]?.[0]).toBe(LITELLM_URL);
    expect(explainModelPricing(source, RETIRED_MODEL)).toMatchObject({
      retired: true,
      pricingKey: RETIRED_MODEL,
    });
  });

  it('does not retry an aborted fetch', async () => {
    const fetchStub = stubFetchServing(payload);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchLiteLLMPricing({ signal: controller.signal })).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and prices from the next response', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const source = await fetchLiteLLMPricing({ url: 'https://example.test/prices.json' });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(source.getPricing('my-model')).toEqual({ inputPer1MUsd: 1, outputPer1MUsd: 2 });
  });

  it('rejects a maxBytes that is not a positive integer without fetching', async () => {
    const fetchStub = stubFetchServing(payload);

    for (const maxBytes of [Number.NaN, 0, -1, 1.5]) {
      await expect(fetchLiteLLMPricing({ maxBytes })).rejects.toThrow(/maxBytes/u);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects a response larger than maxBytes', async () => {
    stubFetchServing(payload);

    await expect(fetchLiteLLMPricing({ maxBytes: 10 })).rejects.toThrow(/exceeds 10 bytes/u);
  });
});
