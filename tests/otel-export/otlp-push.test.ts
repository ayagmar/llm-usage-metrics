import { describe, expect, it } from 'vitest';

import { createUsageEvent } from '../../src/domain/usage-event.js';
import { parseOtlpHeaders, pushOtlp } from '../../src/otel-export/otlp-push.js';
import { buildOtlpTraces, type OtlpTracesData } from '../../src/otel-export/otlp-traces.js';

describe('parseOtlpHeaders', () => {
  it('reads k=v pairs, trims around them and percent-decodes values', () => {
    expect(parseOtlpHeaders(' api-key = a%3Db%2Cc ,authorization=Bearer%20x,')).toEqual({
      'api-key': 'a=b,c',
      authorization: 'Bearer x',
    });
  });

  it('compares names case-insensitively, the later entry winning', () => {
    expect(parseOtlpHeaders('Authorization=old,AUTHORIZATION=new,Content-Type=text/plain')).toEqual(
      {
        authorization: 'new',
        'content-type': 'text/plain',
      },
    );
  });

  it('keeps a raw = inside a value', () => {
    expect(parseOtlpHeaders('token=abc==')).toEqual({ token: 'abc==' });
  });

  it('is empty when the variable is unset or blank', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders('  ')).toEqual({});
  });

  it.each([
    ['secret-value', 'entry 1 is not key=value'],
    ['a=1,bad key=secret-value', 'entry 2 is not key=value'],
    ['key=secret-value%', 'the value of key is not valid percent-encoding'],
    ['key=secret-value%0A', 'the value of key has a line break or NUL'],
  ])('rejects %s without quoting the value', (value, message) => {
    expect(() => parseOtlpHeaders(value)).toThrow(message);

    try {
      parseOtlpHeaders(value);
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });
});

describe('pushOtlp request size', () => {
  // One codex session with a chat span per event: about 700 bytes a span.
  const lines = buildOtlpTraces({
    usageEvents: Array.from({ length: 40 }, (_, index) =>
      createUsageEvent({
        source: 'codex',
        sessionId: 'session-1',
        timestamp: new Date(Date.UTC(2026, 0, 4, 10, 0, index)).toISOString(),
        provider: 'openai',
        model: 'gpt-4.1',
        inputTokens: 10,
        outputTokens: 5,
      }),
    ),
    toolCalls: [],
  });
  const spanCount = lines[0].resourceSpans[0].scopeSpans[0].spans.length;
  const wholeBody = JSON.stringify(lines[0]);

  async function bodiesAt(otlpMaxBatchBytes: number, signalLines = lines): Promise<string[]> {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      bodies.push(String(init?.body));
      return Promise.resolve(new Response('{}'));
    };

    await pushOtlp(
      new URL('http://127.0.0.1:4318'),
      { kind: 'traces', lines: signalLines },
      {},
      { fetchImpl, otlpMaxBatchBytes },
    );
    return bodies;
  }

  const sizes = (bodies: readonly string[]) => bodies.map((body) => Buffer.byteLength(body));
  const spansIn = (bodies: readonly string[]) =>
    bodies.flatMap(
      (body) => (JSON.parse(body) as OtlpTracesData).resourceSpans[0].scopeSpans[0].spans,
    );

  it('sends a session whose body is exactly the limit in one request', async () => {
    const bodies = await bodiesAt(Buffer.byteLength(wholeBody));

    expect(bodies).toEqual([wholeBody]);
  });

  it('keeps every request body of a split session within the limit', async () => {
    for (const limit of [Buffer.byteLength(wholeBody) - 1, 4000, 2500]) {
      const bodies = await bodiesAt(limit);

      expect(bodies.length).toBeGreaterThan(1);
      expect(Math.max(...sizes(bodies))).toBeLessThanOrEqual(limit);
      expect(spansIn(bodies)).toEqual(lines[0].resourceSpans[0].scopeSpans[0].spans);
      expect(spansIn(bodies)).toHaveLength(spanCount);
    }
  });

  it('fills a split piece up to the limit: the next span would not have fit', async () => {
    const limit = 4000;
    const bodies = await bodiesAt(limit);
    const allSpans = spansIn(bodies);
    let offset = 0;

    for (const body of bodies.slice(0, -1)) {
      const parsed = JSON.parse(body) as OtlpTracesData;
      const pieceSpans = parsed.resourceSpans[0].scopeSpans[0].spans;
      offset += pieceSpans.length;
      parsed.resourceSpans[0].scopeSpans[0].spans = [...pieceSpans, allSpans[offset]];

      expect(Buffer.byteLength(JSON.stringify(parsed))).toBeGreaterThan(limit);
    }
  });

  it('merges two sessions into one request only when the merged body fits', async () => {
    const second = buildOtlpTraces({
      usageEvents: [
        createUsageEvent({
          source: 'pi',
          sessionId: 'session-2',
          timestamp: '2026-01-05T10:00:00.000Z',
          inputTokens: 1,
          outputTokens: 1,
        }),
      ],
      toolCalls: [],
    });
    const both = [...lines, ...second];
    const merged = JSON.stringify({
      resourceSpans: both.flatMap((line) => line.resourceSpans),
    });

    expect(await bodiesAt(Buffer.byteLength(merged), both)).toEqual([merged]);
    expect(sizes(await bodiesAt(Buffer.byteLength(merged) - 1, both)).length).toBe(2);
  });
});
