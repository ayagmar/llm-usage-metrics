// Component-attributed hermetic warm event-store query benchmark (plan 077).
//
// Decides whether a warm-store query-path refactor is justified and which
// candidate design wins, by measuring candidate implementations against the
// shipped per-file read path (candidate 1) over a deterministic fixture store.
//
// Run: node --import tsx scripts/perf-warm-query-benchmark.mjs [--smoke]
//      [--history-only] [--large]
//
// Measurement validity: every gated number comes from a FRESH child process
// running exactly one candidate once (peak RSS is a process-lifetime maximum,
// so a shared process would contaminate every candidate). The parent only
// orchestrates and aggregates. Candidate 1's attribution timings may run in
// process; nothing that feeds a frozen threshold does.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { getEventStoreRuntimeConfig } from '../src/config/runtime-overrides.ts';
import { normalizeProviderToBillingEntity } from '../src/domain/provider-normalization.ts';
import { filterUsageEvents } from '../src/cli/parse/usage-event-filters.ts';
import { buildUsageEventDataset } from '../src/cli/build-usage-event-dataset.ts';
import { RuntimeProfileCollector } from '../src/cli/runtime-profile.ts';
import { getUserCacheRootDir } from '../src/utils/cache-root-dir.ts';
import {
  closeEventStore,
  normalizeStoredEvent,
  openEventStore,
  readDepartedFileEvents,
  readFileEvents,
} from '../src/persistence/event-store.ts';
import { buildScenarios, computeExpected, generateFixtures } from './lib/warm-query-fixtures.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ_GUARD_MS = 15 * 60 * 60 * 1000; // > max timezone offset magnitude
const CANDIDATES = ['C1', 'C2', 'C3', 'C5'];
const SAMPLE_RUNS = 5; // fresh child processes per measured cell
const INNER_WARMUP = 3; // in-child warmup iterations (cold JIT / SQLite pages)
const INNER_SAMPLES = 9; // in-child measured iterations; child reports their median
const SPREAD_LIMIT = 1.1; // max/min > this on a decisive metric => INCONCLUSIVE
const ARTIFACTS_DIR = path.resolve('plans/077-artifacts');

const EVENT_COLUMNS = [
  'source',
  'session_id',
  'timestamp',
  'model',
  'provider',
  'repo_root',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'cost_usd',
  'cost_mode',
].join(', ');

// Same columns qualified for joined SELECTs; SQLite still names the result
// columns after the bare column (source, session_id, ...) so normalizeStoredEvent
// reads them unchanged.
const EVENT_COLUMNS_E = EVENT_COLUMNS.split(', ')
  .map((column) => `e.${column}`)
  .join(', ');

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

function pinIsolationEnv(tmpDir) {
  process.env.XDG_CACHE_HOME = path.join(tmpDir, 'xdg-cache');
  process.env.LLM_USAGE_CONFIG_PATH = path.join(tmpDir, 'config.toml');
  process.env.LLM_USAGE_EVENT_STORE = '1';
  process.env.LLM_USAGE_EVENT_STORE_PATH = path.join(tmpDir, 'events.db');
  process.env.LLM_USAGE_PARSE_WORKERS = '0';
  process.env.LLM_USAGE_SKIP_UPDATE_CHECK = '1';
}

// Proves the overrides beat the ambient environment: the resolved store must be
// enabled and every path the benchmark can reach must live under the temp root.
function assertHermetic(tmpDir) {
  const root = path.resolve(tmpDir);
  const storeConfig = getEventStoreRuntimeConfig(process.env, {});

  if (!storeConfig.enabled) {
    throw new Error(
      `Isolation guard: event store resolved disabled (${storeConfig.disabledBy}); refusing to run`,
    );
  }

  const guardedPaths = {
    'event-store path': storeConfig.path,
    'event-store env path': process.env.LLM_USAGE_EVENT_STORE_PATH,
    'cache root': getUserCacheRootDir(process.env),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    'config path': process.env.LLM_USAGE_CONFIG_PATH,
    'pi source dir': path.join(tmpDir, 'pi'),
  };

  for (const [label, value] of Object.entries(guardedPaths)) {
    const resolved = path.resolve(String(value));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Isolation guard: ${label} (${resolved}) escapes temp root ${root}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario query primitives (shared by candidates)
// ---------------------------------------------------------------------------

function widenedUtcRange(scenario) {
  if (!scenario.since && !scenario.until) {
    return undefined;
  }
  const since = scenario.since ?? scenario.until;
  const until = scenario.until ?? scenario.since;
  const lowMs = Date.parse(`${since}T00:00:00.000Z`) - TZ_GUARD_MS;
  const highMs = Date.parse(`${until}T00:00:00.000Z`) + DAY_MS + TZ_GUARD_MS;
  return { lowIso: new Date(lowMs).toISOString(), highIso: new Date(highMs).toISOString() };
}

function buildWhereClause(providerBilling, widened) {
  const clauses = [];
  const params = [];

  if (providerBilling) {
    clauses.push('instr(provider, ?) > 0');
    params.push(providerBilling);
  }
  if (widened) {
    clauses.push('timestamp >= ? AND timestamp <= ?');
    params.push(widened.lowIso, widened.highIso);
  }

  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1', params };
}

function loadStoredFiles(store) {
  return store.database
    .prepare('SELECT source, file_path FROM files ORDER BY source ASC, file_path ASC')
    .all()
    .map((row) => ({ source: String(row.source), filePath: String(row.file_path) }));
}

function resolveUniverse(store, scenario) {
  const files = loadStoredFiles(store);
  if (scenario.kind === 'history') {
    return files.slice(0, Math.floor(scenario.departedFraction * files.length));
  }
  return files;
}

function filterOptionsFor(scenario) {
  return {
    timezone: scenario.timezone,
    since: scenario.since,
    until: scenario.until,
    providerFilter: scenario.provider,
    modelFilter: scenario.model,
  };
}

function retainsWidened(event, providerBilling, widened) {
  if (providerBilling && !(event.provider ?? '').includes(providerBilling)) {
    return false;
  }
  if (widened && (event.timestamp < widened.lowIso || event.timestamp > widened.highIso)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Candidates (implemented here only — src/ is untouched)
// ---------------------------------------------------------------------------

// C1 — shipped behavior: per-file readFileEvents (whole-file invalidation) then
// the production filterUsageEvents oracle.
function runCandidate1(store, ctx) {
  const collected = [];
  let validated = 0;

  for (const file of ctx.universe) {
    const events =
      ctx.semantics === 'skip'
        ? readDepartedFileEvents(store, file.source, file.filePath)
        : readFileEvents(store, file.source, file.filePath);

    if (!events) {
      continue; // whole-file invalidation
    }
    validated += events.length;
    for (const event of events) {
      collected.push(event);
    }
  }

  return { events: filterUsageEvents(collected, ctx.filterOptions), validatedCount: validated };
}

// C5 — validate-all / retain-matching: normalize EVERY row (carry the full
// validated count so per-source eventsParsed is preserved), retain only
// provider/widened-date candidate matches, then residual JS filter.
function runCandidate5(store, ctx) {
  const selectAll = store.database.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE source = ? AND file_path = ? ORDER BY event_index ASC`,
  );
  const collected = [];
  let validated = 0;

  for (const file of ctx.universe) {
    const rows = selectAll.all(file.source, file.filePath);
    const retainedFromFile = [];
    let fileValidated = 0;
    let dropFile = false;

    for (const row of rows) {
      const event = normalizeStoredEvent(row);
      if (!event) {
        if (ctx.semantics === 'skip') {
          continue;
        }
        dropFile = true;
        break;
      }
      fileValidated += 1;
      if (retainsWidened(event, ctx.providerBilling, ctx.widened)) {
        retainedFromFile.push(event);
      }
    }

    if (dropFile) {
      continue;
    }
    validated += fileValidated;
    for (const event of retainedFromFile) {
      collected.push(event);
    }
  }

  return { events: filterUsageEvents(collected, ctx.filterOptions), validatedCount: validated };
}

// C3 — per-file filtered read. Each file pays the whole-file JS validation pass
// (no SQL validity predicate exists) PLUS a filtered SELECT for output.
function runCandidate3(store, ctx) {
  const selectAll = store.database.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE source = ? AND file_path = ? ORDER BY event_index ASC`,
  );
  const where = buildWhereClause(ctx.providerBilling, ctx.widened);
  const selectFiltered = store.database.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE source = ? AND file_path = ? AND ${where.sql} ORDER BY event_index ASC`,
  );
  const collected = [];
  let validated = 0;

  for (const file of ctx.universe) {
    // Validation obligation: normalize the whole file to decide keep/drop.
    const allRows = selectAll.all(file.source, file.filePath);
    let fileValidated = 0;
    let dropFile = false;
    for (const row of allRows) {
      if (!normalizeStoredEvent(row)) {
        if (ctx.semantics === 'skip') {
          continue;
        }
        dropFile = true;
        break;
      }
      fileValidated += 1;
    }
    if (dropFile) {
      continue;
    }
    validated += fileValidated;

    const matchedRows = selectFiltered.all(file.source, file.filePath, ...where.params);
    for (const row of matchedRows) {
      const event = normalizeStoredEvent(row);
      if (event) {
        collected.push(event);
      }
    }
  }

  return { events: filterUsageEvents(collected, ctx.filterOptions), validatedCount: validated };
}

// C2 — set-oriented filtered read: temp table of (source, file_path, ordinal),
// one joined filtered SELECT ordered by (ordinal, event_index), plus the same
// whole-file validation obligation over matched files.
function runCandidate2(store, ctx) {
  const database = store.database;
  const selectAll = database.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE source = ? AND file_path = ? ORDER BY event_index ASC`,
  );
  const where = buildWhereClause(ctx.providerBilling, ctx.widened);

  database.exec('DROP TABLE IF EXISTS tmp_universe');
  database.exec('CREATE TEMP TABLE tmp_universe (source TEXT, file_path TEXT, ordinal INTEGER)');
  const insert = database.prepare(
    'INSERT INTO tmp_universe (source, file_path, ordinal) VALUES (?, ?, ?)',
  );
  ctx.universe.forEach((file, ordinal) => insert.run(file.source, file.filePath, ordinal));

  // Whole-file validation over every file that has ≥1 matching row.
  const matchedFiles = database
    .prepare(
      `SELECT DISTINCT e.source AS source, e.file_path AS file_path, u.ordinal AS ordinal
       FROM events e JOIN tmp_universe u ON e.source = u.source AND e.file_path = u.file_path
       WHERE ${where.sql} ORDER BY u.ordinal ASC`,
    )
    .all(...where.params);

  const droppedFiles = new Set();
  let validated = 0;
  for (const file of matchedFiles) {
    const source = String(file.source);
    const filePath = String(file.file_path);
    const rows = selectAll.all(source, filePath);
    let fileValidated = 0;
    let dropFile = false;
    for (const row of rows) {
      if (!normalizeStoredEvent(row)) {
        if (ctx.semantics === 'skip') {
          continue;
        }
        dropFile = true;
        break;
      }
      fileValidated += 1;
    }
    if (dropFile) {
      droppedFiles.add(`${source}|${filePath}`);
      continue;
    }
    validated += fileValidated;
  }

  // One joined SELECT for output, in canonical (ordinal, event_index) order.
  const outputRows = database
    .prepare(
      `SELECT ${EVENT_COLUMNS_E}, e.file_path AS file_path
       FROM events e JOIN tmp_universe u ON e.source = u.source AND e.file_path = u.file_path
       WHERE ${where.sql} ORDER BY u.ordinal ASC, e.event_index ASC`,
    )
    .all(...where.params);

  const collected = [];
  for (const row of outputRows) {
    if (droppedFiles.has(`${String(row.source)}|${String(row.file_path)}`)) {
      continue;
    }
    const event = normalizeStoredEvent(row);
    if (event) {
      collected.push(event);
    }
  }

  database.exec('DROP TABLE IF EXISTS tmp_universe');
  return { events: filterUsageEvents(collected, ctx.filterOptions), validatedCount: validated };
}

const CANDIDATE_RUNNERS = {
  C1: runCandidate1,
  C2: runCandidate2,
  C3: runCandidate3,
  C5: runCandidate5,
};

function buildContext(store, scenario) {
  return {
    universe: resolveUniverse(store, scenario),
    semantics: scenario.kind === 'history' ? 'skip' : 'drop',
    widened: widenedUtcRange(scenario),
    providerBilling: scenario.provider
      ? normalizeProviderToBillingEntity(scenario.provider)
      : undefined,
    filterOptions: filterOptionsFor(scenario),
  };
}

function runCandidate(candidate, store, ctx) {
  const runner = CANDIDATE_RUNNERS[candidate];
  if (!runner) {
    throw new Error(`Unknown candidate: ${candidate}`);
  }
  return runner(store, ctx);
}

// ---------------------------------------------------------------------------
// Output fingerprinting (equality oracle across processes)
// ---------------------------------------------------------------------------

function fingerprintEvents(events) {
  const hash = createHash('sha256');
  let tokenTotal = 0;
  for (const event of events) {
    tokenTotal += event.totalTokens;
    hash.update(
      `${event.source}${event.sessionId}${event.timestamp}${event.provider ?? ''}` +
        `${event.model ?? ''}${event.inputTokens},${event.outputTokens},${event.reasoningTokens},` +
        `${event.cacheReadTokens},${event.cacheWriteTokens},${event.totalTokens}${event.costMode}` +
        `${event.costUsd ?? ''}`,
    );
  }
  return { count: events.length, tokenTotal, orderHash: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// Child cell: one candidate, one scenario, one run, fresh process
// ---------------------------------------------------------------------------

async function runChildCell(args) {
  const tmpDir = args.tmp;
  pinIsolationEnv(tmpDir);
  assertHermetic(tmpDir);

  const scenario = JSON.parse(Buffer.from(args['scenario-b64'], 'base64').toString('utf8'));
  const [candidate, scenarioName, run] = args.cell.split(':');
  const store = await openEventStore(process.env.LLM_USAGE_EVENT_STORE_PATH);

  try {
    const ctx = buildContext(store, scenario);

    // In-child warmup then repeated measured iterations. Wall time of a single
    // cold iteration is dominated by JIT/page-cache first-touch jitter; the
    // median of warm iterations is stable. Peak RSS stays the process maximum
    // (each iteration's arrays are released before the next), so it still
    // reflects this candidate's retained-memory footprint.
    for (let iteration = 0; iteration < INNER_WARMUP; iteration += 1) {
      runCandidate(candidate, store, ctx);
    }

    const innerWalls = [];
    let result;
    for (let iteration = 0; iteration < INNER_SAMPLES; iteration += 1) {
      const startedAt = performance.now();
      result = runCandidate(candidate, store, ctx);
      innerWalls.push(performance.now() - startedAt);
    }

    const fingerprint = fingerprintEvents(result.events);
    const maxRssKb = process.resourceUsage().maxRSS;

    process.stdout.write(
      `${JSON.stringify({
        candidate,
        scenario: scenarioName,
        run: Number(run),
        wallMs: median(innerWalls),
        maxRssKb,
        validatedCount: result.validatedCount,
        ...fingerprint,
      })}\n`,
    );
  } finally {
    closeEventStore(store);
  }
}

function spawnCell(tmpDir, candidate, scenario, run) {
  const cellId = `${candidate}:${scenario.name}:${run}`;
  const scenarioB64 = Buffer.from(JSON.stringify(scenario), 'utf8').toString('base64');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      SCRIPT_PATH,
      '--cell',
      cellId,
      '--tmp',
      tmpDir,
      '--scenario-b64',
      scenarioB64,
    ],
    { env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );

  if (child.status !== 0) {
    throw new Error(`Child cell ${cellId} failed (status ${child.status}):\n${child.stderr ?? ''}`);
  }

  const line = child.stdout.trim().split('\n').at(-1);
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// Aggregation + frozen-threshold verdicts
// ---------------------------------------------------------------------------

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function spreadRatio(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === 0 ? Infinity : max / min;
}

function percentChange(candidateValue, baselineValue) {
  return baselineValue === 0 ? 0 : ((candidateValue - baselineValue) / baselineValue) * 100;
}

// ---------------------------------------------------------------------------
// Cold ingest + attribution (candidate 1 only, in-process context)
// ---------------------------------------------------------------------------

async function coldIngest(piDir) {
  const collector = new RuntimeProfileCollector();
  const dataset = await buildUsageEventDataset(
    { source: 'pi', piDir, timezone: 'UTC', pricingOffline: true },
    { runtimeProfile: collector },
  );
  return {
    stageTimings: collector.snapshot().stageTimings,
    ingestedEvents: dataset.filteredEvents.length,
  };
}

function componentAttribution(store, files) {
  const selectAll = store.database.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE source = ? AND file_path = ? ORDER BY event_index ASC`,
  );

  const discoveryStart = performance.now();
  const universe = files;
  const discoveryMs = performance.now() - discoveryStart;

  let selectMs = 0;
  let normalizeMs = 0;
  const collected = [];

  for (const file of universe) {
    const selectStart = performance.now();
    const rows = selectAll.all(file.source, file.filePath);
    selectMs += performance.now() - selectStart;

    const normalizeStart = performance.now();
    for (const row of rows) {
      const event = normalizeStoredEvent(row);
      if (event) {
        collected.push(event);
      }
    }
    normalizeMs += performance.now() - normalizeStart;
  }

  const filterStart = performance.now();
  filterUsageEvents(collected, { timezone: 'UTC' });
  const filterMs = performance.now() - filterStart;

  return {
    fileDiscoveryMs: Number(discoveryMs.toFixed(3)),
    sqlSelectAllMs: Number(selectMs.toFixed(3)),
    normalizeMs: Number(normalizeMs.toFixed(3)),
    jsFilterMs: Number(filterMs.toFixed(3)),
  };
}

// ---------------------------------------------------------------------------
// Full matrix over one store size
// ---------------------------------------------------------------------------

async function measureSize(sizeKey, scenarios) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `perf-warm-query-${sizeKey}-`));
  pinIsolationEnv(tmpDir);
  assertHermetic(tmpDir);

  const fixtures = generateFixtures(tmpDir, sizeKey);
  const ingest = await coldIngest(fixtures.piDir);

  const store = await openEventStore(process.env.LLM_USAGE_EVENT_STORE_PATH);
  const attribution = componentAttribution(store, loadStoredFiles(store));
  closeEventStore(store);

  const scenarioResults = [];

  for (const scenario of scenarios) {
    // History scenarios only serve departed files (the sorted prefix of the
    // store), so the independent oracle must see that same event subset.
    const scenarioEvents =
      scenario.kind === 'history'
        ? fixtures.events.slice(
            0,
            Math.floor(scenario.departedFraction * fixtures.totalFiles) * fixtures.eventsPerFile,
          )
        : fixtures.events;
    const expected = computeExpected(scenarioEvents, scenario);
    const runsWanted = scenario.measured ? SAMPLE_RUNS : 1;
    const perCandidate = {};
    let baselineFingerprint;

    for (const candidate of CANDIDATES) {
      const samples = [];
      let fingerprint;
      let validatedCount;

      for (let run = 0; run < runsWanted; run += 1) {
        const cell = spawnCell(tmpDir, candidate, scenario, run);
        fingerprint = { count: cell.count, tokenTotal: cell.tokenTotal, orderHash: cell.orderHash };
        validatedCount = cell.validatedCount;
        samples.push({ wallMs: cell.wallMs, maxRssKb: cell.maxRssKb });
      }

      perCandidate[candidate] = {
        fingerprint,
        validatedCount,
        wallMsMedian: median(samples.map((sample) => sample.wallMs)),
        maxRssKbMedian: median(samples.map((sample) => sample.maxRssKb)),
        wallSpread: spreadRatio(samples.map((sample) => sample.wallMs)),
        rssSpread: spreadRatio(samples.map((sample) => sample.maxRssKb)),
        samples,
      };
      if (candidate === 'C1') {
        baselineFingerprint = fingerprint;
      }
    }

    // Validation: C1 vs independent oracle, then every candidate vs C1.
    const c1 = perCandidate.C1;
    const c1MatchesOracle =
      c1.fingerprint.count === expected.count && c1.fingerprint.tokenTotal === expected.tokenTotal;
    const candidateEquality = {};
    for (const candidate of CANDIDATES) {
      candidateEquality[candidate] =
        perCandidate[candidate].fingerprint.orderHash === baselineFingerprint.orderHash;
    }

    scenarioResults.push({
      scenario,
      expected,
      matchedFraction: c1.fingerprint.count / fixtures.totalEvents,
      c1MatchesOracle,
      candidateEquality,
      perCandidate,
    });
  }

  await rm(tmpDir, { recursive: true, force: true });

  return {
    sizeKey,
    cardinality: { events: fixtures.totalEvents, files: fixtures.totalFiles },
    ingest,
    attribution,
    scenarioResults,
  };
}

// ---------------------------------------------------------------------------
// Verdict evaluation against the FROZEN thresholds
// ---------------------------------------------------------------------------

function findScenario(sizeResult, name) {
  return sizeResult.scenarioResults.find((entry) => entry.scenario.name === name);
}

function metricUsable(c1, cand, metric) {
  return Math.max(c1[metric], cand[metric]) <= SPREAD_LIMIT;
}

// (a) — one tier: wall improvement >=15% OR RSS improvement >=25%. A metric may
// only affirm/deny if its run-to-run spread is within the limit; a metric that
// WOULD affirm but is too noisy forces INCONCLUSIVE rather than a false deny.
function evaluateTierA(c1, cand) {
  const wallGainPct = ((c1.wallMsMedian - cand.wallMsMedian) / c1.wallMsMedian) * 100;
  const rssGainPct = ((c1.maxRssKbMedian - cand.maxRssKbMedian) / c1.maxRssKbMedian) * 100;
  const wallUsable = metricUsable(c1, cand, 'wallSpread');
  const rssUsable = metricUsable(c1, cand, 'rssSpread');

  const affirmed = (wallGainPct >= 15 && wallUsable) || (rssGainPct >= 25 && rssUsable);
  if (affirmed) {
    return { pass: true, inconclusive: false, wallGainPct, rssGainPct };
  }

  const wouldAffirmButNoisy =
    (wallGainPct >= 15 && !wallUsable) || (rssGainPct >= 25 && !rssUsable);
  const cleanDeny = wallUsable && rssUsable && wallGainPct < 15 && rssGainPct < 25;
  return { pass: false, inconclusive: wouldAffirmButNoisy || !cleanDeny, wallGainPct, rssGainPct };
}

// (b) — tier100: wall regression <=3% AND RSS regression <=5%. Both metrics are
// decisive. A metric far past its bound (>2x) is a clean fail even if noisy; a
// borderline decision resting on a noisy metric forces INCONCLUSIVE.
function evaluateTierB(c1, cand) {
  const wallRegressionPct = percentChange(cand.wallMsMedian, c1.wallMsMedian);
  const rssRegressionPct = percentChange(cand.maxRssKbMedian, c1.maxRssKbMedian);
  const wallUsable = metricUsable(c1, cand, 'wallSpread');
  const rssUsable = metricUsable(c1, cand, 'rssSpread');
  const pass = wallRegressionPct <= 3 && rssRegressionPct <= 5;

  if (pass) {
    return {
      pass: true,
      inconclusive: !(wallUsable && rssUsable),
      wallRegressionPct,
      rssRegressionPct,
    };
  }

  const wallClearFail = wallRegressionPct > 6 && wallRegressionPct > 3;
  const rssClearFail = rssRegressionPct > 10 && rssRegressionPct > 5;
  const cleanFail =
    (wallRegressionPct > 3 && (wallUsable || wallClearFail)) ||
    (rssRegressionPct > 5 && (rssUsable || rssClearFail));
  return { pass: false, inconclusive: !cleanFail, wallRegressionPct, rssRegressionPct };
}

function evaluateVerdict(sizeResults) {
  const medium = sizeResults.find((entry) => entry.sizeKey === 'medium') ?? sizeResults.at(-1);
  const findings = [];
  const perCandidate = {};

  for (const candidate of CANDIDATES.filter((name) => name !== 'C1')) {
    const evaluation = { candidate, checks: {}, noisyCells: [], fixtureFailures: [] };

    // (d) equality + (c) validation-count preservation on every scenario. Both
    // are deterministic (counts / hashes), so they carry no run-to-run spread.
    let equalityHeld = true;
    let validationPreserved = true;
    for (const sizeResult of sizeResults) {
      for (const entry of sizeResult.scenarioResults) {
        if (!entry.c1MatchesOracle) {
          evaluation.fixtureFailures.push(
            `C1 != oracle @ ${sizeResult.sizeKey}/${entry.scenario.name}`,
          );
        }
        if (!entry.candidateEquality[candidate]) {
          equalityHeld = false;
        }
        const validated = entry.perCandidate[candidate].validatedCount;
        if (validated !== sizeResult.cardinality.events && entry.scenario.kind !== 'history') {
          validationPreserved = false;
        }
      }
    }
    evaluation.checks.d_equality = equalityHeld;
    evaluation.checks.c_validationCount = validationPreserved;

    // (a) MEDIUM tier1 + tier10: wall improvement >=15% OR RSS improvement >=25%.
    const aTiers = [];
    for (const tierName of ['tier1-oneday', 'tier10-tenday']) {
      const entry = findScenario(medium, tierName);
      const tier = evaluateTierA(entry.perCandidate.C1, entry.perCandidate[candidate]);
      evaluation.checks[`a_${tierName}`] = tier;
      aTiers.push(tier);
      if (tier.inconclusive) {
        evaluation.noisyCells.push(`medium/${tierName} (a)`);
      }
    }
    evaluation.checks.a = aTiers.every((tier) => tier.pass);

    // (b) tier100, EVERY size: wall regression <=3% AND RSS regression <=5%.
    const bSizes = [];
    for (const sizeResult of sizeResults) {
      const entry = findScenario(sizeResult, 'tier100-unfiltered');
      const tier = evaluateTierB(entry.perCandidate.C1, entry.perCandidate[candidate]);
      evaluation.checks[`b_${sizeResult.sizeKey}`] = tier;
      bSizes.push(tier);
      if (tier.inconclusive) {
        evaluation.noisyCells.push(`${sizeResult.sizeKey}/tier100 (b)`);
      }
    }
    evaluation.checks.b = bSizes.every((tier) => tier.pass);

    // Honor the frozen rule's "on any cell NEEDED to affirm or deny" qualifier.
    // A candidate is cleanly denied if ANY threshold fails on a deterministic
    // (c/d) or low-spread (clean-fail) cell — noise on OTHER cells is then not
    // needed for the verdict. It is INCONCLUSIVE only if it is neither cleanly
    // denied nor cleanly affirmed, i.e. the verdict genuinely rests on a noisy
    // cell. Fixture-validation failure is an unconditional INCONCLUSIVE.
    const cleanlyDenied =
      !equalityHeld ||
      !validationPreserved ||
      aTiers.some((tier) => !tier.pass && !tier.inconclusive) ||
      bSizes.some((tier) => !tier.pass && !tier.inconclusive);
    const cleanlyAffirmed =
      equalityHeld &&
      validationPreserved &&
      aTiers.every((tier) => tier.pass && !tier.inconclusive) &&
      bSizes.every((tier) => tier.pass && !tier.inconclusive);

    evaluation.go = cleanlyAffirmed;
    evaluation.status =
      evaluation.fixtureFailures.length > 0
        ? 'INCONCLUSIVE'
        : cleanlyAffirmed
          ? 'GO'
          : cleanlyDenied
            ? 'NO-GO'
            : 'INCONCLUSIVE';
    perCandidate[candidate] = evaluation;
    findings.push(evaluation);
  }

  const statuses = findings.map((entry) => entry.status);
  const recommendation = statuses.includes('GO')
    ? 'GO'
    : statuses.every((status) => status === 'NO-GO')
      ? 'NO-GO'
      : 'INCONCLUSIVE';

  return { recommendation, perCandidate };
}

async function reevaluate() {
  const target = path.join(ARTIFACTS_DIR, 'full-matrix-results.json');
  const summary = JSON.parse(await readFile(target, 'utf8'));
  summary.verdict = evaluateVerdict(summary.sizeResults);
  summary.reevaluatedAt = new Date().toISOString();
  await writeFile(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`RECOMMENDATION (re-evaluated): ${summary.verdict.recommendation}\n`);
  for (const [candidate, evaluation] of Object.entries(summary.verdict.perCandidate)) {
    process.stdout.write(
      `  ${candidate}: ${evaluation.status} (noisy cells: ${evaluation.noisyCells.join(', ') || 'none'})\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Artifact writing
// ---------------------------------------------------------------------------

async function writeArtifacts(label, payload) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const target = path.join(ARTIFACTS_DIR, `${label}.json`);
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runSmoke() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'perf-warm-query-smoke-'));
  pinIsolationEnv(tmpDir);
  assertHermetic(tmpDir);

  process.stdout.write(`benchmark: tempDir=${tmpDir}\n`);
  process.stdout.write(`benchmark: eventStorePath=${process.env.LLM_USAGE_EVENT_STORE_PATH}\n`);
  process.stdout.write(`benchmark: cacheRoot=${getUserCacheRootDir(process.env)}\n`);
  process.stdout.write(
    `benchmark: eventStoreEnabled=${getEventStoreRuntimeConfig(process.env, {}).enabled}\n`,
  );

  const fixtures = generateFixtures(tmpDir, 'smoke');
  await coldIngest(fixtures.piDir);

  const { windowed, special } = buildScenarios('smoke');
  const smokeScenarios = [
    windowed.find((entry) => entry.name === 'tier100-unfiltered'),
    windowed.find((entry) => entry.name === 'tier10-tenday'),
    ...special,
  ];

  const store = await openEventStore(process.env.LLM_USAGE_EVENT_STORE_PATH);
  let failures = 0;

  try {
    for (const scenario of smokeScenarios) {
      const expected = computeExpected(fixtures.events, scenario);
      const ctx = buildContext(store, scenario);
      const baseline = runCandidate('C1', store, ctx);
      const baselinePrint = fingerprintEvents(baseline.events);

      if (
        baselinePrint.count !== expected.count ||
        baselinePrint.tokenTotal !== expected.tokenTotal
      ) {
        failures += 1;
        process.stdout.write(
          `smoke FAIL ${scenario.name}: C1 count=${baselinePrint.count}/${expected.count} tokens=${baselinePrint.tokenTotal}/${expected.tokenTotal}\n`,
        );
        continue;
      }

      let scenarioOk = true;
      for (const candidate of ['C2', 'C3', 'C5']) {
        const result = runCandidate(candidate, store, buildContext(store, scenario));
        const print = fingerprintEvents(result.events);
        if (print.orderHash !== baselinePrint.orderHash) {
          failures += 1;
          scenarioOk = false;
          process.stdout.write(`smoke FAIL ${scenario.name}: ${candidate} != C1\n`);
        }
      }
      if (scenarioOk) {
        process.stdout.write(
          `smoke OK ${scenario.name}: ${baselinePrint.count} events (fraction ${(expected.fraction * 100).toFixed(2)}%)\n`,
        );
      }
    }
  } finally {
    closeEventStore(store);
  }

  await rm(tmpDir, { recursive: true, force: true });
  process.stdout.write(`benchmark: cleanedUp=${!existsSync(tmpDir)}\n`);

  if (failures > 0) {
    process.stdout.write(`smoke: ${failures} failure(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('smoke: all scenarios validated\n');
}

async function runHistoryOnly() {
  const scenarios = buildScenarios('medium').history;
  const sizeResult = await measureSize('medium', scenarios);
  const verdictInputs = [sizeResult];

  const summary = {
    mode: 'history-only',
    generatedAt: new Date().toISOString(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    sizeResults: verdictInputs,
  };
  const artifact = await writeArtifacts('history-only-results', summary);

  for (const entry of sizeResult.scenarioResults) {
    const c1 = entry.perCandidate.C1;
    process.stdout.write(
      `history ${entry.scenario.name}: departed=${entry.scenario.departedFraction} events=${entry.expected.count} ` +
        `C1=${c1.wallMsMedian.toFixed(1)}ms equalityHeld=${Object.values(entry.candidateEquality).every(Boolean)}\n`,
    );
  }
  process.stdout.write(`history-only artifacts: ${artifact}\n`);
}

async function runFullMatrix(includeLarge) {
  const sizeKeys = includeLarge ? ['small', 'medium', 'large'] : ['small', 'medium'];
  const sizeResults = [];

  for (const sizeKey of sizeKeys) {
    const { windowed, special, history } = buildScenarios(sizeKey);
    const scenarios = [...windowed, ...special, ...history];
    process.stdout.write(`measuring ${sizeKey} (${scenarios.length} scenarios)...\n`);
    sizeResults.push(await measureSize(sizeKey, scenarios));
  }

  const verdict = evaluateVerdict(sizeResults);
  const summary = {
    mode: 'full-matrix',
    generatedAt: new Date().toISOString(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    thresholds: {
      a: 'MEDIUM tier1 & tier10: wall improvement >=15% OR RSS improvement >=25% vs C1',
      b: 'tier100 every size: wall regression <=3% AND RSS regression <=5% vs C1',
      c: 'validated count == all stored events (per-source eventsParsed preserved)',
      d: 'candidate output byte-identical to C1',
      inconclusive: 'run-to-run spread (max/min) > 10% on any decisive cell',
    },
    verdict,
    sizeResults,
  };

  const artifact = await writeArtifacts('full-matrix-results', summary);
  process.stdout.write(`\nRECOMMENDATION: ${verdict.recommendation}\n`);
  process.stdout.write(`artifacts: ${artifact}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.cell) {
    await runChildCell(args);
    return;
  }
  if (args.smoke) {
    await runSmoke();
    return;
  }
  if (args['history-only']) {
    await runHistoryOnly();
    return;
  }
  if (args.reeval) {
    await reevaluate();
    return;
  }
  await runFullMatrix(Boolean(args.large));
}

await main();
