// End-to-end check of `events --format otlp-traces` against a real Jaeger v2, by hand only
// (not in CI). Needs `pnpm run build` and docker usable without sudo.
//
//   node scripts/otel-jaeger-check.mjs
//
// It exports the tools fixtures with the built CLI under a temporary HOME, starts
// `jaegertracing/jaeger` with its ports bound to 127.0.0.1 only, posts each line to the
// OTLP/HTTP endpoint, reads every trace back from the query API, compares trace and span
// counts and a few attributes, and removes the container. JAEGER_IMAGE overrides the image.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'dist', 'bin.js');
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'tools');
const image = process.env.JAEGER_IMAGE ?? 'jaegertracing/jaeger:2.22.0';
const containerName = `llm-usage-otel-check-${process.pid}`;
const READY_TIMEOUT_MS = 60_000;
const QUERY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exportFixtureTraces() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'llm-usage-otel-check-'));

  try {
    const output = run(
      process.execPath,
      [
        cliPath,
        'events',
        '--format',
        'otlp-traces',
        '--source',
        'claude,codex,pi',
        '--claude-dir',
        path.join(fixturesDir, 'claude'),
        '--codex-dir',
        path.join(fixturesDir, 'codex'),
        '--pi-dir',
        path.join(fixturesDir, 'pi'),
        '--timezone',
        'UTC',
        '--pricing-offline',
        '--no-sync',
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_DATA_HOME: path.join(home, '.local', 'share'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          LLM_USAGE_CONFIG_PATH: path.join(home, 'missing-config.toml'),
          LLM_USAGE_SKIP_UPDATE_CHECK: '1',
        },
      },
    );
    return output
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function hostPort(containerPort) {
  // `docker port` prints `127.0.0.1:49153`.
  const mapping = run('docker', ['port', containerName, `${containerPort}/tcp`]).trim();
  return mapping.split('\n')[0].split(':').pop();
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

function spansOf(data) {
  return data.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
}

function tagValue(span, key) {
  return span.tags.find((tag) => tag.key === key)?.value;
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function main() {
  const lines = await exportFixtureTraces();
  if (lines.length === 0) {
    throw new Error('The fixture export printed no traces');
  }

  run('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-p',
    '127.0.0.1::4318',
    '-p',
    '127.0.0.1::16686',
    image,
  ]);

  try {
    const otlpUrl = `http://127.0.0.1:${hostPort(4318)}/v1/traces`;
    const queryUrl = `http://127.0.0.1:${hostPort(16686)}`;

    for (const data of lines) {
      await waitFor(
        async () => {
          const response = await fetch(otlpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          if (!response.ok) {
            throw new Error(`OTLP POST returned ${response.status}: ${await response.text()}`);
          }
          return true;
        },
        READY_TIMEOUT_MS,
        'the OTLP/HTTP endpoint',
      );
    }

    let spanCount = 0;

    for (const data of lines) {
      const expected = spansOf(data);
      const traceId = expected[0].traceId;
      const trace = await waitFor(
        async () => {
          const response = await fetch(`${queryUrl}/api/traces/${traceId}`);
          if (!response.ok) {
            return undefined;
          }
          const body = await response.json();
          const found = body.data?.[0];
          return found && found.spans.length === expected.length ? found : undefined;
        },
        QUERY_TIMEOUT_MS,
        `trace ${traceId} with ${expected.length} spans`,
      );
      const serviceName = data.resourceSpans[0].resource.attributes.find(
        (attribute) => attribute.key === 'service.name',
      ).value.stringValue;
      const root = trace.spans.find((span) => span.operationName.startsWith('invoke_agent'));

      assertEqual(trace.processes[root.processID].serviceName, serviceName, 'service name');
      assertEqual(root.operationName, expected[0].name, 'root span name');
      assertEqual(
        String(tagValue(root, 'gen_ai.usage.input_tokens')),
        expected[0].attributes.find((attribute) => attribute.key === 'gen_ai.usage.input_tokens')
          .value.intValue,
        'root input tokens',
      );

      const expectedErrors = expected.filter((span) => span.status?.code === 2).length;
      const errors = trace.spans.filter((span) => tagValue(span, 'error') === true).length;
      assertEqual(errors, expectedErrors, `failed tool spans in ${serviceName}`);

      for (const span of trace.spans.filter((candidate) => candidate !== root)) {
        assertEqual(span.references?.[0]?.spanID, root.spanID, `parent of ${span.operationName}`);

        if (span.operationName.startsWith('execute_tool')) {
          assertEqual(
            tagValue(span, 'gen_ai.agent.name'),
            serviceName,
            `agent of ${span.operationName}`,
          );
        }
      }

      spanCount += trace.spans.length;
    }

    console.log(`Jaeger check passed: ${lines.length} traces, ${spanCount} spans (${image}).`);
  } finally {
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
