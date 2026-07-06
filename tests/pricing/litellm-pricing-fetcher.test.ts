import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LiteLLMPricingFetcher,
  type LiteLLMPricingFetcherOptions,
} from '../../src/pricing/litellm-pricing-fetcher.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

function createFetcher(options: LiteLLMPricingFetcherOptions = {}): LiteLLMPricingFetcher {
  return new LiteLLMPricingFetcher({
    sourceUrl: 'https://example.test/litellm-pricing.json',
    ...options,
  });
}

describe('LiteLLMPricingFetcher', () => {
  it('downloads, validates and resolves models via prefix and fuzzy lookup', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
              cache_read_input_token_cost: 0.00000015,
              output_cost_per_reasoning_token: 0.00002,
            },
            'gpt-5.2': {
              input_cost_per_token: 0.00000125,
              output_cost_per_token: 0.00001,
            },
            'gpt-4.1': {
              input_cost_per_token: 0.000002,
              output_cost_per_token: 0.000008,
            },
            'not-a-valid-entry': {
              model: 'broken',
            },
          }),
          { status: 200 },
        );
      }),
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);

    const codexPrefixPricing = fetcher.getPricing('openai/gpt-5.2-codex-2026-01-01');
    const genericPrefixPricing = fetcher.getPricing('gpt-5.2-2026-01-01');
    const fuzzyPricing = fetcher.getPricing('gpt52codex');

    expect(codexPrefixPricing).toBeDefined();
    expect(codexPrefixPricing?.inputPer1MUsd).toBeCloseTo(1.5, 10);
    expect(codexPrefixPricing?.cacheReadPer1MUsd).toBeCloseTo(0.15, 10);
    expect(codexPrefixPricing?.reasoningPer1MUsd).toBeCloseTo(20, 10);
    expect(codexPrefixPricing?.reasoningBilling).toBe('separate');

    expect(genericPrefixPricing).toBeDefined();
    expect(genericPrefixPricing?.inputPer1MUsd).toBeCloseTo(1.25, 10);
    expect(fuzzyPricing).toBeDefined();
    expect(fuzzyPricing?.outputPer1MUsd).toBeCloseTo(10, 10);
  });

  it('ignores pricing entries with blank numeric string values', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-blank-values-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'broken-model': {
              input_cost_per_token: '   ',
              output_cost_per_token: 0.00001,
            },
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
          }),
          { status: 200 },
        );
      }),
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    expect(fetcher.getPricing('broken-model')).toBeUndefined();
    expect(fetcher.getPricing('gpt-5.2-codex')).toBeDefined();
  });

  it('accepts string-encoded numeric values from remote payload', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-string-remote-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: '0.0000015',
              output_cost_per_token: '0.00001',
              cache_read_input_token_cost: '0.00000015',
              output_cost_per_reasoning_token: '0.00002',
            },
          }),
          { status: 200 },
        );
      }),
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    const pricing = fetcher.getPricing('gpt-5.2-codex');
    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1MUsd).toBeCloseTo(1.5, 10);
    expect(pricing?.outputPer1MUsd).toBeCloseTo(10, 10);
    expect(pricing?.cacheReadPer1MUsd).toBeCloseTo(0.15, 10);
    expect(pricing?.reasoningPer1MUsd).toBeCloseTo(20, 10);
    expect(pricing?.reasoningBilling).toBe('separate');
  });

  it('uses cache-write priority pricing field when standard field is absent', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cache-write-priority-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
              cache_creation_input_token_cost_priority: 0.0000004,
            },
          }),
          { status: 200 },
        );
      }),
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    expect(fetcher.getPricing('gpt-5.2-codex')?.cacheWritePer1MUsd).toBeCloseTo(0.4, 10);
  });

  it('throws when LiteLLM payload is not a JSON object and no cache is available', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-invalid-payload-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(['not-an-object']), { status: 200 }),
      ),
      fetchRetryCount: 0,
    });

    await expect(fetcher.load()).rejects.toThrow(
      'Could not load LiteLLM pricing from network or cache',
    );
  });

  it('throws when LiteLLM payload has no usable pricing entries and no cache is available', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-no-usable-entries-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'broken-model': {
              input_cost_per_token: ' ',
              output_cost_per_token: '',
            },
          }),
          { status: 200 },
        );
      }),
      fetchRetryCount: 0,
    });

    await expect(fetcher.load()).rejects.toThrow(
      'Could not load LiteLLM pricing from network or cache',
    );
  });

  it('treats future cache timestamps as stale and refreshes from remote', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-future-cache-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue + 60_000,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: {
          'gpt-5.2-codex': {
            inputPer1MUsd: 1,
            outputPer1MUsd: 2,
          },
        },
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          'gpt-5.2-codex': {
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.00001,
          },
        }),
        { status: 200 },
      );
    });

    const fetcher = createFetcher({
      cacheFilePath,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      now: () => nowValue,
      fetchImpl: fetchSpy,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetcher.getPricing('gpt-5.2-codex')?.inputPer1MUsd).toBeCloseTo(3, 10);
  });

  it('uses cached pricing in offline mode', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-offline-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');

    const onlineFetcher = createFetcher({
      cacheFilePath,
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
          }),
          { status: 200 },
        );
      }),
    });

    const onlineLoadedFromCache = await onlineFetcher.load();

    expect(onlineLoadedFromCache).toBe(false);

    const offlineFetcher = createFetcher({
      cacheFilePath,
      offline: true,
      cacheTtlMs: 1,
      now: () => Date.now() + 10_000,
      fetchImpl: vi.fn(async () => {
        throw new Error('Offline fetch should not be called');
      }),
    });

    const offlineLoadedFromCache = await offlineFetcher.load();

    expect(offlineLoadedFromCache).toBe(true);
    expect(offlineFetcher.getPricing('gpt-5.2-codex')).toBeDefined();
  });

  it('does not reuse cache when source URL differs', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-source-url-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');

    const onlineFetcher = createFetcher({
      cacheFilePath,
      sourceUrl: 'https://example.test/pricing-A.json',
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
          }),
          { status: 200 },
        );
      }),
    });

    const onlineLoadedFromCache = await onlineFetcher.load();

    expect(onlineLoadedFromCache).toBe(false);

    const offlineFetcherWithDifferentSource = createFetcher({
      cacheFilePath,
      sourceUrl: 'https://example.test/pricing-B.json',
      offline: true,
    });

    await expect(offlineFetcherWithDifferentSource.load()).rejects.toThrow(
      'Offline pricing mode enabled',
    );
  });

  it('keeps remote pricing when cache write fails', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cache-write-fail-'));
    tempDirs.push(rootDir);

    const blockingPath = path.join(rootDir, 'not-a-directory');
    await rm(blockingPath, { force: true });
    await writeFile(blockingPath, 'blocked', 'utf8');

    const fetcher = createFetcher({
      cacheFilePath: path.join(blockingPath, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
          }),
          { status: 200 },
        );
      }),
    });

    const fromCache = await fetcher.load();
    expect(fromCache).toBe(false);
    expect(fetcher.getPricing('gpt-5.2-codex')).toBeDefined();
  });

  it('retries transient LiteLLM fetch failures before succeeding', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-retry-success-'));
    tempDirs.push(rootDir);
    const sleepSpy = vi.fn(async () => undefined);
    const fetchSpy = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
          }),
          { status: 200 },
        ),
      );

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: fetchSpy,
      fetchRetryCount: 2,
      fetchRetryDelayMs: 10,
      sleep: sleepSpy,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 10);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 20);
    expect(fetcher.getPricing('gpt-5.2-codex')).toBeDefined();
  });

  it('falls back to stale cache after retry exhaustion on transient failures', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-retry-stale-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue - 10_000,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: {
          'gpt-5.2-codex': {
            inputPer1MUsd: 1.5,
            outputPer1MUsd: 10,
          },
        },
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      throw new Error('network timeout');
    });

    const fetcher = createFetcher({
      cacheFilePath,
      cacheTtlMs: 100,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      fetchRetryCount: 2,
      sleep: async () => undefined,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetcher.getPricing('gpt-5.2-codex')?.inputPer1MUsd).toBeCloseTo(1.5, 10);
  });

  it('falls back to stale cache when content-length exceeds the response byte limit', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-content-length-cap-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue - 10_000,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: {
          'gpt-5.2-codex': {
            inputPer1MUsd: 1.5,
            outputPer1MUsd: 10,
          },
        },
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          'gpt-5.2-codex': {
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.00001,
          },
        }),
        { status: 200, headers: { 'content-length': '4096' } },
      );
    });

    const fetcher = createFetcher({
      cacheFilePath,
      cacheTtlMs: 100,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      maxResponseBytes: 1024,
      fetchRetryCount: 0,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetcher.getPricing('gpt-5.2-codex')?.inputPer1MUsd).toBeCloseTo(1.5, 10);
  });

  it('rejects streamed bodies exceeding the byte limit when content-length is absent', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-stream-cap-'));
    tempDirs.push(rootDir);

    const oversizedPayload = JSON.stringify({
      'gpt-5.2-codex': {
        input_cost_per_token: 0.0000015,
        output_cost_per_token: 0.00001,
      },
      padding: 'x'.repeat(2048),
    });

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => new Response(oversizedPayload, { status: 200 })),
      maxResponseBytes: 1024,
      fetchRetryCount: 0,
    });

    await expect(fetcher.load()).rejects.toThrow(
      'Could not load LiteLLM pricing from network or cache',
    );
  });

  it('does not retry when the response exceeds the byte limit', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cap-no-retry-'));
    tempDirs.push(rootDir);

    const sleepSpy = vi.fn(async () => undefined);
    const fetchSpy = vi.fn(async () => {
      return new Response('x'.repeat(2048), { status: 200 });
    });

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: fetchSpy,
      maxResponseBytes: 1024,
      fetchRetryCount: 2,
      sleep: sleepSpy,
    });

    await expect(fetcher.load()).rejects.toThrow(
      'Could not load LiteLLM pricing from network or cache',
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('parses payloads under a custom byte limit', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-under-cap-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
          }),
          { status: 200 },
        );
      }),
      maxResponseBytes: 1024,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    expect(fetcher.getPricing('gpt-5.2-codex')?.inputPer1MUsd).toBeCloseTo(1.5, 10);
  });

  it('ignores malformed cached pricing entries and keeps valid normalized entries', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cache-normalize-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: {
          'invalid-missing-input': {
            outputPer1MUsd: 2,
          },
          'invalid-not-an-object': 'bad-value',
          'valid-model': {
            inputPer1MUsd: 1.5,
            outputPer1MUsd: 10,
            cacheReadPer1MUsd: 0.2,
            cacheWritePer1MUsd: 0.4,
            reasoningPer1MUsd: 20,
          },
        },
      }),
      'utf8',
    );

    const fetcher = createFetcher({
      cacheFilePath,
      now: () => nowValue,
      offline: true,
      fetchRetryCount: 0,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(true);
    expect(fetcher.getPricing('invalid-missing-input')).toBeUndefined();
    expect(fetcher.getPricing('invalid-not-an-object')).toBeUndefined();
    const validPricing = fetcher.getPricing('valid-model');
    expect(validPricing).toBeDefined();
    expect(validPricing?.inputPer1MUsd).toBeCloseTo(1.5, 10);
    expect(validPricing?.outputPer1MUsd).toBeCloseTo(10, 10);
    expect(validPricing?.cacheReadPer1MUsd).toBeCloseTo(0.2, 10);
    expect(validPricing?.cacheWritePer1MUsd).toBeCloseTo(0.4, 10);
    expect(validPricing?.reasoningPer1MUsd).toBeCloseTo(20, 10);
    expect(validPricing?.reasoningBilling).toBe('separate');
  });

  it('normalizes string-encoded cached pricing numbers and skips null entries', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cache-string-values-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: {
          'null-entry': null,
          'valid-model': {
            inputPer1MUsd: '1.5',
            outputPer1MUsd: '10',
            cacheReadPer1MUsd: '0.2',
            cacheWritePer1MUsd: '0.4',
            reasoningPer1MUsd: '20',
          },
        },
      }),
      'utf8',
    );

    const fetcher = createFetcher({
      cacheFilePath,
      now: () => nowValue,
      offline: true,
      fetchRetryCount: 0,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(true);
    expect(fetcher.getPricing('null-entry')).toBeUndefined();
    const validPricing = fetcher.getPricing('valid-model');
    expect(validPricing).toBeDefined();
    expect(validPricing?.inputPer1MUsd).toBeCloseTo(1.5, 10);
    expect(validPricing?.outputPer1MUsd).toBeCloseTo(10, 10);
    expect(validPricing?.cacheReadPer1MUsd).toBeCloseTo(0.2, 10);
    expect(validPricing?.cacheWritePer1MUsd).toBeCloseTo(0.4, 10);
    expect(validPricing?.reasoningPer1MUsd).toBeCloseTo(20, 10);
    expect(validPricing?.reasoningBilling).toBe('separate');
  });

  it('ignores malformed cache payload shape and falls back to remote', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cache-shape-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: 'not-an-object',
      }),
      'utf8',
    );

    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          'gpt-5.2-codex': {
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.00001,
          },
        }),
        { status: 200 },
      );
    });

    const fetcher = createFetcher({
      cacheFilePath,
      now: () => nowValue,
      fetchImpl: fetchSpy,
      fetchRetryCount: 0,
    });

    const loadedFromCache = await fetcher.load();

    expect(loadedFromCache).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetcher.getPricing('gpt-5.2-codex')?.inputPer1MUsd).toBeCloseTo(3, 10);
  });

  it('rejects offline cache when all cached pricing entries are malformed', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-cache-all-invalid-'));
    tempDirs.push(rootDir);

    const cacheFilePath = path.join(rootDir, 'cache.json');
    const nowValue = 1_000_000;

    await writeFile(
      cacheFilePath,
      JSON.stringify({
        fetchedAt: nowValue,
        sourceUrl: 'https://example.test/litellm-pricing.json',
        pricingByModel: {
          'invalid-1': {
            inputPer1MUsd: 1.5,
          },
          'invalid-2': {
            outputPer1MUsd: 10,
          },
        },
      }),
      'utf8',
    );

    const fetcher = createFetcher({
      cacheFilePath,
      now: () => nowValue,
      offline: true,
      fetchRetryCount: 0,
    });

    await expect(fetcher.load()).rejects.toThrow(
      'Offline pricing mode enabled but no cached LiteLLM pricing is available',
    );
  });

  it('resolves configured canonical aliases to preferred LiteLLM pricing keys', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-canonical-map-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'moonshot/kimi-k2.5': {
              input_cost_per_token: 0.0000006,
              output_cost_per_token: 0.000003,
            },
            'gpt-5.3-codex': {
              input_cost_per_token: 0.00000175,
              output_cost_per_token: 0.000014,
            },
            'gemini/gemini-3-flash-preview': {
              input_cost_per_token: 0.0000005,
              output_cost_per_token: 0.000003,
            },
            'gemini/gemini-3-pro-preview': {
              input_cost_per_token: 0.000002,
              output_cost_per_token: 0.000012,
            },
            'openrouter/minimax/minimax-m2.1': {
              input_cost_per_token: 0.00000027,
              output_cost_per_token: 0.0000012,
            },
            'openrouter/minimax/minimax-m2.5': {
              input_cost_per_token: 0.0000003,
              output_cost_per_token: 0.0000011,
            },
            'anthropic.claude-sonnet-4-6': {
              input_cost_per_token: 0.000003,
              output_cost_per_token: 0.000015,
            },
          }),
          { status: 200 },
        );
      }),
    });

    await fetcher.load();

    expect(fetcher.resolveModelAlias('k2p5')).toBe('moonshot/kimi-k2.5');
    expect(fetcher.resolveModelAlias('moonshotai.kimi-k2.5')).toBe('moonshot/kimi-k2.5');
    expect(fetcher.resolveModelAlias('gpt-5.3-codex-spark')).toBe('gpt-5.3-codex');
    expect(fetcher.resolveModelAlias('kimi-k2.5-free')).toBe('moonshot/kimi-k2.5');
    expect(fetcher.resolveModelAlias('gemini-3-pro')).toBe('gemini/gemini-3-pro-preview');
    expect(fetcher.resolveModelAlias('antigravity-gemini-3-flash')).toBe(
      'gemini/gemini-3-flash-preview',
    );
    expect(fetcher.resolveModelAlias('antigravity-gemini-3-pro-high')).toBe(
      'gemini/gemini-3-pro-preview',
    );
    expect(fetcher.resolveModelAlias('minimax-m2.1-free')).toBe('openrouter/minimax/minimax-m2.1');
    expect(fetcher.resolveModelAlias('minimax-m2.5-free')).toBe('openrouter/minimax/minimax-m2.5');
    expect(fetcher.resolveModelAlias('claude-sonnet-4.6')).toBe('anthropic.claude-sonnet-4-6');

    expect(fetcher.getPricing('k2p5')?.inputPer1MUsd).toBeCloseTo(0.6, 10);
    expect(fetcher.getPricing('kimi-k2.5')?.outputPer1MUsd).toBeCloseTo(3, 10);
    expect(fetcher.getPricing('gpt-5.3-codex-spark')?.inputPer1MUsd).toBeCloseTo(1.75, 10);
    expect(fetcher.getPricing('kimi-k2.5-free')?.outputPer1MUsd).toBeCloseTo(3, 10);
    expect(fetcher.getPricing('gemini-3-pro')?.outputPer1MUsd).toBeCloseTo(12, 10);
    expect(fetcher.getPricing('antigravity-gemini-3-flash')?.inputPer1MUsd).toBeCloseTo(0.5, 10);
    expect(fetcher.getPricing('minimax-m2.1-free')?.inputPer1MUsd).toBeCloseTo(0.27, 10);
    expect(fetcher.getPricing('minimax-m2.5-free')?.outputPer1MUsd).toBeCloseTo(1.1, 10);
    expect(fetcher.getPricing('claude sonnet 4.6')?.outputPer1MUsd).toBeCloseTo(15, 10);
  });

  it('resolves -a suffixed gemini-3 aliases to preferred gemini preview pricing keys', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-gemini-a-suffix-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gemini/gemini-3-flash-preview': {
              input_cost_per_token: 0.0000005,
              output_cost_per_token: 0.000003,
            },
            'gemini/gemini-3-pro-preview': {
              input_cost_per_token: 0.000002,
              output_cost_per_token: 0.000012,
            },
          }),
          { status: 200 },
        );
      }),
    });

    await fetcher.load();

    expect(fetcher.resolveModelAlias('gemini-3-flash-a')).toBe('gemini/gemini-3-flash-preview');
    expect(fetcher.resolveModelAlias('gemini-3-flash')).toBe('gemini/gemini-3-flash-preview');
    expect(fetcher.resolveModelAlias('gemini-3-pro-a')).toBe('gemini/gemini-3-pro-preview');

    expect(fetcher.getPricing('gemini-3-flash-a')?.inputPer1MUsd).toBeCloseTo(0.5, 10);
    expect(fetcher.getPricing('gemini-3-flash')?.outputPer1MUsd).toBeCloseTo(3, 10);
    expect(fetcher.getPricing('gemini-3-pro-a')?.outputPer1MUsd).toBeCloseTo(12, 10);
  });

  it('uses direct gpt-5.3-codex pricing when available upstream', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-codex-fallback-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'gpt-5': {
              input_cost_per_token: 0.00000125,
              output_cost_per_token: 0.00001,
            },
            'gpt-5.2-codex': {
              input_cost_per_token: 0.0000015,
              output_cost_per_token: 0.00001,
            },
            'gpt-5.3-codex': {
              input_cost_per_token: 0.00000175,
              output_cost_per_token: 0.000014,
            },
          }),
          { status: 200 },
        );
      }),
    });

    await fetcher.load();

    expect(fetcher.resolveModelAlias('gpt-5.3-codex')).toBe('gpt-5.3-codex');
    expect(fetcher.getPricing('gpt-5.3-codex')?.inputPer1MUsd).toBeCloseTo(1.75, 10);
  });

  it('matches provider-prefixed LiteLLM keys from bare model names', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-provider-prefix-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'openrouter/anthropic/claude-sonnet-4.5': {
              input_cost_per_token: 0.000003,
              output_cost_per_token: 0.000015,
            },
          }),
          { status: 200 },
        );
      }),
    });

    await fetcher.load();

    expect(fetcher.resolveModelAlias('claude-sonnet-4.5')).toBe(
      'openrouter/anthropic/claude-sonnet-4.5',
    );
    expect(fetcher.getPricing('claude-sonnet-4.5')?.outputPer1MUsd).toBeCloseTo(15, 10);
  });

  it('falls back to normal matching when preferred mapped key is unavailable', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-map-fallback-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      fetchImpl: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            'moonshotai.kimi-k2.5': {
              input_cost_per_token: 0.0000006,
              output_cost_per_token: 0.000003,
            },
          }),
          { status: 200 },
        );
      }),
    });

    await fetcher.load();

    const pricing = fetcher.getPricing('k2p5');

    expect(pricing).toBeDefined();
    expect(pricing?.inputPer1MUsd).toBeCloseTo(0.6, 10);
    expect(fetcher.resolveModelAlias('k2p5')).toBe('moonshotai.kimi-k2.5');
  });

  it('throws in offline mode when cache is unavailable', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-pricing-missing-cache-'));
    tempDirs.push(rootDir);

    const fetcher = createFetcher({
      cacheFilePath: path.join(rootDir, 'cache.json'),
      offline: true,
    });

    await expect(fetcher.load()).rejects.toThrow('Offline pricing mode enabled');
  });
});
