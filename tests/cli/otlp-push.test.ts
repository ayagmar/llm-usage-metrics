import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runEventsReport } from '../../src/cli/run-events-report.js';
import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import type { OtlpPushDeps } from '../../src/otel-export/otlp-push.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import { useBundledPricingOnly } from '../helpers/offline-pricing.js';

const FIXTURES = path.resolve('tests/fixtures/tools');
const FIXTURE_OPTIONS = {
  claudeDir: path.join(FIXTURES, 'claude'),
  codexDir: path.join(FIXTURES, 'codex'),
  piDir: path.join(FIXTURES, 'pi'),
  source: 'claude,codex,pi',
  timezone: 'UTC',
  pricingOffline: true,
};
const NOW = () => new Date('2026-07-01T00:00:00.000Z');
const SECRET = 'Bearer s3cr3t token';
// Captured before useBundledPricingOnly stubs `fetch`; the push may only reach 127.0.0.1.
const realFetch = globalThis.fetch;
const loopbackFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);

  if (url.hostname !== '127.0.0.1') {
    throw new Error(`test push left 127.0.0.1: ${url.host}`);
  }

  return realFetch(input, init);
};

type ReceivedRequest = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
type Responder = (response: ServerResponse, index: number) => void;

/** An OTLP receiver on 127.0.0.1 that records requests and answers with `respond`. */
async function startReceiver(respond: Responder = (response) => response.end('{}')) {
  const requests: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      respond(response, requests.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  receivers.push(server);

  return { requests, endpoint: `http://127.0.0.1:${port}` };
}

const receivers: ReturnType<typeof createServer>[] = [];

function setHeadersEnv(value: string): void {
  process.env.OTEL_EXPORTER_OTLP_HEADERS = value;
}

type RunOutput = { stdout: string; stderr: string };

async function runEvents(
  options: EventsCommandOptions,
  deps: OtlpPushDeps = {},
): Promise<RunOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(`${args.join(' ')}\n`);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await runEventsReport(
      { ...FIXTURE_OPTIONS, ...options },
      { now: NOW, fetchImpl: loopbackFetch, ...deps },
    );
  } finally {
    vi.restoreAllMocks();
  }

  return { stdout: stdout.join(''), stderr: stderr.join('') };
}

function linesOf(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}

type SentSpan = { traceId: string; spanId: string; parentSpanId?: string };

/** The spans of export lines or request bodies, in order. */
function spansOf(jsons: readonly string[]): SentSpan[] {
  return jsons.flatMap((json) =>
    (
      JSON.parse(json) as { resourceSpans: { scopeSpans: { spans: SentSpan[] }[] }[] }
    ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
  );
}

/** The resources of each export line or request body, re-serialized one by one. */
function resourcesOf(json: string, key: 'resourceSpans' | 'resourceMetrics'): string[] {
  const parsed = JSON.parse(json) as Record<string, unknown[]>;
  return parsed[key].map((resource) => JSON.stringify(resource));
}

describe('events --otlp-endpoint', () => {
  useIsolatedEnvironment();
  useBundledPricingOnly();

  afterEach(async () => {
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    await Promise.all(
      receivers.splice(0).map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      ),
    );
  });

  it('posts the traces export resources unchanged, with the configured headers', async () => {
    const receiver = await startReceiver();
    const exported = linesOf((await runEvents({ format: 'otlp-traces' })).stdout);
    vi.stubEnv(
      'OTEL_EXPORTER_OTLP_HEADERS',
      `authorization=${encodeURIComponent(SECRET)}, x-tenant = t1, Content-Type=text/plain`,
    );

    const output = await runEvents({
      format: 'otlp-traces',
      otlpEndpoint: `${receiver.endpoint}/`,
    });

    expect(exported.length).toBeGreaterThan(1);
    expect(output.stdout).toBe('');
    expect(receiver.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /v1/traces',
    ]);
    expect(resourcesOf(receiver.requests[0].body, 'resourceSpans')).toEqual(
      exported.flatMap((line) => resourcesOf(line, 'resourceSpans')),
    );
    expect(receiver.requests[0].headers['content-type']).toBe('application/json');
    expect(receiver.requests[0].headers.authorization).toBe(SECRET);
    expect(receiver.requests[0].headers['x-tenant']).toBe('t1');

    const summary = linesOf(output.stderr).filter((line) => line.includes('Pushed'));
    expect(summary).toEqual([
      `ℹ Pushed ${spansOf(exported).length} spans in 1 batch to ${receiver.endpoint}/v1/traces`,
    ]);
    expect(output.stderr).not.toContain('s3cr3t');
  });

  it('splits a session larger than the request limit, root span first, keeping its ids', async () => {
    const receiver = await startReceiver();
    const exported = linesOf((await runEvents({ format: 'otlp-traces' })).stdout);
    const sizes = exported.map((line) => Buffer.byteLength(line));
    const largest = exported[sizes.indexOf(Math.max(...sizes))];
    const largestSpans = spansOf([largest]);
    // Room for about a third of the largest session per request.
    const otlpMaxBatchBytes = Math.ceil(Math.max(...sizes) / 3);

    const output = await runEvents(
      { format: 'otlp-traces', otlpEndpoint: receiver.endpoint },
      { otlpMaxBatchBytes },
    );
    const bodies = receiver.requests.map((request) => request.body);
    const sent = spansOf(bodies);

    expect(largestSpans.length).toBeGreaterThan(3);
    expect(bodies.every((body) => Buffer.byteLength(body) <= otlpMaxBatchBytes)).toBe(true);
    expect(sent).toEqual(spansOf(exported));
    const largestTrace = largestSpans[0].traceId;
    const piecesOfLargest = bodies.filter((body) => body.includes(largestTrace));
    expect(piecesOfLargest.length).toBeGreaterThanOrEqual(3);
    expect(spansOf([piecesOfLargest[0]]).find((span) => span.traceId === largestTrace)).toEqual(
      largestSpans[0],
    );
    expect(largestSpans[0].parentSpanId).toBeUndefined();
    expect(output.stderr).toContain(
      `Pushed ${sent.length} spans in ${bodies.length} batches to ${receiver.endpoint}/v1/traces`,
    );
  });

  it('merges whole metrics lines into one request at the default batch size', async () => {
    const receiver = await startReceiver();
    const exported = linesOf((await runEvents({ format: 'otlp-metrics' })).stdout);

    const output = await runEvents({ format: 'otlp-metrics', otlpEndpoint: receiver.endpoint });

    expect(exported.length).toBeGreaterThan(1);
    expect(output.stdout).toBe('');
    expect(receiver.requests.map((request) => request.url)).toEqual(['/v1/metrics']);
    expect(resourcesOf(receiver.requests[0].body, 'resourceMetrics')).toEqual(
      exported.flatMap((line) => resourcesOf(line, 'resourceMetrics')),
    );
    expect(output.stderr).toMatch(/Pushed \d+ points in 1 batch to /u);
  });

  it('appends the signal path to an endpoint with a base path', async () => {
    const receiver = await startReceiver();

    await runEvents({ format: 'otlp-metrics', otlpEndpoint: `${receiver.endpoint}/otlp` });

    expect(receiver.requests.map((request) => request.url)).toEqual(['/otlp/v1/metrics']);
  });

  it('uses an endpoint that already ends with the signal path as is', async () => {
    const receiver = await startReceiver();

    await runEvents({
      format: 'otlp-traces',
      otlpEndpoint: `${receiver.endpoint}/otlp/v1/traces/`,
    });

    expect(receiver.requests.map((request) => request.url)).toEqual(['/otlp/v1/traces']);
  });

  it('sends the endpoint query string but never prints it', async () => {
    const receiver = await startReceiver((response, index) => {
      response.writeHead(index === 0 ? 200 : 400).end('{}');
    });
    const otlpEndpoint = `${receiver.endpoint}/otlp?token=dummy#part`;

    const output = await runEvents({ format: 'otlp-metrics', otlpEndpoint });
    const failure = runEvents({ format: 'otlp-metrics', otlpEndpoint });

    expect(receiver.requests[0].url).toBe('/otlp/v1/metrics?token=dummy');
    expect(output.stderr).toContain(`to ${receiver.endpoint}/otlp/v1/metrics\n`);
    await expect(failure).rejects.toThrow(
      `OTLP push to ${receiver.endpoint}/otlp/v1/metrics failed`,
    );
    await expect(failure).rejects.not.toThrow('dummy');
  });

  it('reports spans the receiver rejected in a partial success', async () => {
    const receiver = await startReceiver((response) =>
      response.end(
        JSON.stringify({ partialSuccess: { rejectedSpans: '2', errorMessage: 'too old' } }),
      ),
    );

    const output = await runEvents({ format: 'otlp-traces', otlpEndpoint: receiver.endpoint });

    expect(output.stderr).toContain('; the receiver rejected 2 (too old)');
  });

  it('retries once after Retry-After on 429 and 503', async () => {
    const receiver = await startReceiver((response, index) => {
      if (index === 0) {
        response.writeHead(429, { 'Retry-After': '0' }).end();
        return;
      }

      response.end('{}');
    });

    const output = await runEvents({ format: 'otlp-metrics', otlpEndpoint: receiver.endpoint });

    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[1].body).toBe(receiver.requests[0].body);
    expect(output.stderr).toContain('in 1 batch');
  });

  it.each([429, 502, 503, 504])(
    'retries a %i without Retry-After after a default delay',
    async (status) => {
      const receiver = await startReceiver((response, index) => {
        if (index < 2) {
          response.writeHead(status).end();
          return;
        }

        response.end('{}');
      });

      const output = await runEvents(
        { format: 'otlp-metrics', otlpEndpoint: receiver.endpoint },
        { otlpRetryDelayMs: 1 },
      );

      expect(receiver.requests).toHaveLength(3);
      expect(output.stderr).toContain('in 1 batch');
    },
  );

  it('fails after four attempts when the receiver keeps throttling', async () => {
    const receiver = await startReceiver((response) =>
      response.writeHead(503, { 'Retry-After': '0' }).end(),
    );

    await expect(
      runEvents({ format: 'otlp-metrics', otlpEndpoint: receiver.endpoint }),
    ).rejects.toThrow(/failed after 0 of 1 batches \(0 points sent\): HTTP 503 .*try again later/u);
    expect(receiver.requests).toHaveLength(4);
  });

  it('does not retry a 500 or a Retry-After over a minute', async () => {
    const failing = await startReceiver((response) => response.writeHead(500).end());
    const slow = await startReceiver((response) =>
      response.writeHead(429, { 'Retry-After': '120' }).end(),
    );

    await expect(
      runEvents({ format: 'otlp-metrics', otlpEndpoint: failing.endpoint }),
    ).rejects.toThrow('HTTP 500');
    await expect(
      runEvents({ format: 'otlp-metrics', otlpEndpoint: slow.endpoint }),
    ).rejects.toThrow('HTTP 429');
    expect(failing.requests).toHaveLength(1);
    expect(slow.requests).toHaveLength(1);
  });

  it('redacts header values a receiver echoes in an error or a partial success', async () => {
    setHeadersEnv(`authorization=${encodeURIComponent('Bearer s3cr3t-token-value')}`);
    const failing = await startReceiver((response) =>
      response.writeHead(400).end('bad request: Authorization: Bearer s3cr3t-token-value'),
    );
    const partial = await startReceiver((response) =>
      response.end(
        JSON.stringify({
          partialSuccess: { rejectedDataPoints: '1', errorMessage: 'token s3cr3t-token-value' },
        }),
      ),
    );

    const failure = runEvents({ format: 'otlp-metrics', otlpEndpoint: failing.endpoint });
    await expect(failure).rejects.toThrow('(bad request: Authorization: [redacted])');
    await expect(failure).rejects.not.toThrow('s3cr3t');
    const output = await runEvents({ format: 'otlp-metrics', otlpEndpoint: partial.endpoint });
    expect(output.stderr).toContain('the receiver rejected 1 (token [redacted])');
    expect(output.stderr).not.toContain('s3cr3t');
  });

  it('stops at a 4xx with the receiver message and a hint, never the header values', async () => {
    setHeadersEnv(`authorization=${encodeURIComponent(SECRET)}`);
    const receiver = await startReceiver((response) =>
      response
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: 16, message: 'missing\n  token' })),
    );

    const failure = runEvents(
      { format: 'otlp-traces', otlpEndpoint: receiver.endpoint },
      { otlpMaxBatchBytes: 1 },
    );

    await expect(failure).rejects.toThrow(
      `OTLP push to ${receiver.endpoint}/v1/traces failed after 0 of`,
    );
    await expect(failure).rejects.toThrow(
      /HTTP 401 Unauthorized \(missing token\); check the credentials in OTEL_EXPORTER_OTLP_HEADERS$/u,
    );
    await expect(failure).rejects.not.toThrow('s3cr3t');
    expect(receiver.requests).toHaveLength(1);
  });

  it('hints at the base URL on a 404', async () => {
    const receiver = await startReceiver((response) => response.writeHead(404).end('not here'));

    await expect(
      runEvents({ format: 'otlp-metrics', otlpEndpoint: `${receiver.endpoint}/v1/metrics` }),
    ).rejects.toThrow('HTTP 404 Not Found (not here); pass the receiver base URL');
  });

  it.each([302, 307])(
    'fails on a %i redirect without following it or sending the headers on',
    async (status) => {
      setHeadersEnv('x-api-key=dummy');
      const target = await startReceiver();
      const receiver = await startReceiver((response) =>
        response.writeHead(status, { Location: `${target.endpoint}/elsewhere` }).end(),
      );

      await expect(
        runEvents({ format: 'otlp-traces', otlpEndpoint: receiver.endpoint }),
      ).rejects.toThrow(
        new RegExp(`HTTP ${status} .*; the receiver redirects; pass the final receiver URL$`, 'u'),
      );
      expect(receiver.requests).toHaveLength(1);
      expect(target.requests).toEqual([]);
    },
  );

  it('times out when the receiver does not answer', async () => {
    const receiver = await startReceiver(() => undefined);

    await expect(
      runEvents(
        { format: 'otlp-metrics', otlpEndpoint: receiver.endpoint },
        { otlpTimeoutMs: 100 },
      ),
    ).rejects.toThrow('no response within 0.1 s; check that a receiver listens there');
  });

  it('names the connection error when nothing listens', async () => {
    const receiver = await startReceiver();
    const endpoint = receiver.endpoint;
    await new Promise((resolve) => receivers.splice(0)[0].close(resolve));

    await expect(runEvents({ format: 'otlp-metrics', otlpEndpoint: endpoint })).rejects.toThrow(
      /ECONNREFUSED.*check the endpoint URL/u,
    );
  });

  it.each([
    ['ftp://127.0.0.1:4318', '--otlp-endpoint must use http: or https:, got ftp:'],
    ['localhost:4318', '--otlp-endpoint must use http: or https:, got localhost:'],
    ['127.0.0.1:4318', '--otlp-endpoint must be an http: or https: URL'],
    ['not a url', '--otlp-endpoint must be an http: or https: URL'],
    ['http://user:pass@127.0.0.1:4318', '--otlp-endpoint must not carry credentials'],
  ])('rejects the endpoint %s before reading anything', async (otlpEndpoint, message) => {
    const createAdapters = vi.fn(() => []);

    await expect(
      runEventsReport({ format: 'otlp-traces', otlpEndpoint }, { createAdapters }),
    ).rejects.toThrow(message);
    expect(createAdapters).not.toHaveBeenCalled();
  });

  it('rejects --otlp-endpoint with a non-OTLP format', async () => {
    await expect(
      runEventsReport({ format: 'jsonl', otlpEndpoint: 'http://127.0.0.1:4318' }),
    ).rejects.toThrow('--otlp-endpoint needs --format otlp-traces or --format otlp-metrics');
  });
});
