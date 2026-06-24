import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicApiSourceAdapter } from '../../src/sources/anthropic-api/anthropic-api-source-adapter.js';

const originalAdminKey = process.env.ANTHROPIC_ADMIN_KEY;

afterEach(() => {
  if (originalAdminKey === undefined) {
    delete process.env.ANTHROPIC_ADMIN_KEY;
  } else {
    process.env.ANTHROPIC_ADMIN_KEY = originalAdminKey;
  }

  vi.restoreAllMocks();
});

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function getFetchCallUrl(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  callIndex: number,
): URL {
  const requestInput = fetchMock.mock.calls[callIndex]?.[0];

  if (typeof requestInput !== 'string') {
    throw new Error('Expected fetch URL to be a string');
  }

  return new URL(requestInput);
}

describe('AnthropicApiSourceAdapter', () => {
  it('requires an admin API key when explicitly parsed', async () => {
    delete process.env.ANTHROPIC_ADMIN_KEY;

    const adapter = new AnthropicApiSourceAdapter();

    await expect(adapter.parseSourceWithDiagnostics()).rejects.toThrow(
      'Anthropic Admin API key is required in ANTHROPIC_ADMIN_KEY',
    );
  });

  it('fetches message usage, follows pagination, and maps token buckets', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'admin-key';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          usage_buckets: [
            {
              starting_at: '2026-06-01T00:00:00Z',
              results: [
                {
                  model: 'claude-opus-4-8',
                  input_tokens: 10,
                  cache_creation_input_tokens: 2,
                  cache_read_input_tokens: 3,
                  output_tokens: 4,
                },
              ],
            },
          ],
          has_more: true,
          next_page: 'page-2',
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          usage_buckets: [
            {
              starting_at: '2026-06-02T00:00:00Z',
              results: [
                {
                  model: 'claude-haiku-4-5-20251001',
                  uncached_input_tokens: 11,
                  output_tokens: 5,
                },
              ],
            },
          ],
          has_more: false,
        }),
      );

    const adapter = new AnthropicApiSourceAdapter({
      since: '2026-06-01',
      until: '2026-06-02',
      fetchImpl: fetchMock,
    });

    const result = await adapter.parseSourceWithDiagnostics();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = getFetchCallUrl(fetchMock, 0);
    const secondUrl = getFetchCallUrl(fetchMock, 1);
    expect(firstUrl.searchParams.get('starting_at')).toBe('2026-06-01T00:00:00Z');
    expect(firstUrl.searchParams.get('ending_at')).toBe('2026-06-03T00:00:00Z');
    expect(firstUrl.searchParams.get('bucket_width')).toBe('1d');
    expect(firstUrl.searchParams.getAll('group_by[]')).toEqual(['model']);
    expect(secondUrl.searchParams.get('page')).toBe('page-2');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'x-api-key': 'admin-key',
      'anthropic-version': '2023-06-01',
    });
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      source: 'anthropic-api',
      sessionId: 'anthropic-api:2026-06-01:claude-opus-4-8',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 10,
      cacheWriteTokens: 2,
      cacheReadTokens: 3,
      outputTokens: 4,
      totalTokens: 19,
      costMode: 'estimated',
    });
    expect(result.events[1]).toMatchObject({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
    });
    expect(result.sourceItemsFound).toBe(2);
  });

  it('defaults to the trailing 31-day window when no date flags are present', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'admin-key';
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      createJsonResponse({
        usage_buckets: [],
        has_more: false,
      }),
    );

    const adapter = new AnthropicApiSourceAdapter({
      now: () => new Date('2026-06-24T12:00:00.000Z'),
      fetchImpl: fetchMock,
    });

    await adapter.parseSourceWithDiagnostics();

    const url = getFetchCallUrl(fetchMock, 0);
    expect(url.searchParams.get('starting_at')).toBe('2026-05-25T00:00:00Z');
    expect(url.searchParams.get('ending_at')).toBe('2026-06-25T00:00:00Z');
  });

  it('chunks explicit ranges longer than 31 days', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'admin-key';
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      createJsonResponse({
        usage_buckets: [],
        has_more: false,
      }),
    );

    const adapter = new AnthropicApiSourceAdapter({
      since: '2026-01-01',
      until: '2026-02-05',
      fetchImpl: fetchMock,
    });

    await adapter.parseSourceWithDiagnostics();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getFetchCallUrl(fetchMock, 0).searchParams.get('ending_at')).toBe(
      '2026-02-01T00:00:00Z',
    );
    expect(getFetchCallUrl(fetchMock, 1).searchParams.get('starting_at')).toBe(
      '2026-02-01T00:00:00Z',
    );
  });
});
