// Deterministic, seeded fixture generator for the warm event-store query
// benchmark (plan 077). Emits pi-format JSONL files and computes expected
// per-scenario counts INDEPENDENTLY of the production filter path (via raw
// Intl date bucketing) so candidate 1 can be validated, not trusted blindly.
//
// No Date.now(), no unseeded randomness: the same size always produces the
// same store, so every run compares like against like.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const EVENTS_PER_FILE = 50;
const REPO_ROOT = '/repo/warm-query-bench';

// billing provider -> raw provider string written to JSONL. Using
// "openai-codex" exercises the provider->billing-entity normalization the
// store applies on write, so stored provider = billing entity ("openai").
const MODEL_MIX = [
  { billingProvider: 'openai', rawProvider: 'openai-codex', model: 'gpt-4.1' },
  { billingProvider: 'openai', rawProvider: 'openai-codex', model: 'gpt-4o' },
  { billingProvider: 'anthropic', rawProvider: 'anthropic', model: 'claude-sonnet-4-5' },
  { billingProvider: 'anthropic', rawProvider: 'anthropic', model: 'claude-haiku-4-5' },
];

export const SIZE_PRESETS = {
  smoke: { events: 400, files: 8, specialFiles: 1 },
  small: { events: 20_000, files: 400, specialFiles: 4 },
  medium: { events: 120_000, files: 2_400, specialFiles: 8 },
  large: { events: 360_000, files: 7_200, specialFiles: 12 },
};

// Main band: 100 contiguous UTC days at ~noon so the date is stable across UTC
// and Europe/Paris. Windowed selectivity tiers query slices of this band.
const MAIN_BAND_START_MS = Date.UTC(2026, 4, 1, 12, 0, 0); // 2026-05-01T12:00Z
const MAIN_BAND_DAYS = 100;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// Independent local-date bucketer: a plain Intl call, deliberately NOT the
// production getPeriodKey, so it can serve as an oracle for that code path.
const dateFormatterCache = new Map();
function localDateKey(timestampIso, timezone) {
  let formatter = dateFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormatterCache.set(timezone, formatter);
  }
  return formatter.format(new Date(timestampIso));
}

function buildSpecialTimestamps(count, kind, rng) {
  const stamps = [];

  if (kind === 'utc') {
    // A single UTC day with events spread across the hours.
    for (let i = 0; i < count; i += 1) {
      stamps.push(Date.UTC(2026, 0, 15, i % 24, (i * 7) % 60, 0));
    }
    return stamps;
  }

  if (kind === 'paris') {
    // Straddle local midnight in Europe/Paris (summer, +2) so some events land
    // on a different local date than their UTC date.
    for (let i = 0; i < count; i += 1) {
      const base = i % 3 === 0 ? Date.UTC(2026, 5, 14, 23, 30, 0) : Date.UTC(2026, 5, 15, 12, 0, 0);
      stamps.push(base + (i % 30) * 60_000);
    }
    return stamps;
  }

  if (kind === 'dst') {
    // Europe/Paris spring-forward week (2026-03-29 02:00 local -> 03:00).
    const windowStart = Date.UTC(2026, 2, 28, 20, 0, 0);
    for (let i = 0; i < count; i += 1) {
      stamps.push(windowStart + Math.floor(rng() * 56) * HOUR_MS * 0.6);
    }
    return stamps;
  }

  // saopaulo: 2019 DST-end midnight transition. Events between 22:00Z on the
  // 16th and 05:00Z on the 17th; the local date 2019-02-16 has a
  // non-contiguous UTC preimage — the residual-oracle scenario.
  const windowStart = Date.UTC(2019, 1, 16, 22, 0, 0);
  for (let i = 0; i < count; i += 1) {
    stamps.push(windowStart + Math.floor((i / Math.max(1, count)) * 7 * HOUR_MS));
  }
  return stamps;
}

function buildTimestamps(mainCount, specialCount, rng) {
  const timestamps = [];

  for (let i = 0; i < mainCount; i += 1) {
    const day = Math.floor((i * MAIN_BAND_DAYS) / mainCount);
    timestamps.push(MAIN_BAND_START_MS + day * DAY_MS + (i % EVENTS_PER_FILE) * 60_000);
  }

  // Split the special files across the four timezone categories.
  const utc = Math.round(specialCount * 0.4);
  const paris = Math.round(specialCount * 0.2);
  const dst = Math.round(specialCount * 0.3);
  const saopaulo = specialCount - utc - paris - dst;

  return {
    mainTimestamps: timestamps,
    specialTimestamps: [
      ...buildSpecialTimestamps(utc, 'utc', rng),
      ...buildSpecialTimestamps(paris, 'paris', rng),
      ...buildSpecialTimestamps(dst, 'dst', rng),
      ...buildSpecialTimestamps(saopaulo, 'saopaulo', rng),
    ],
  };
}

/**
 * Generates the fixture store on disk and returns the canonical in-memory event
 * list (normalized exactly as the store persists them) plus metadata.
 */
export function generateFixtures(tmpDir, sizeKey) {
  const preset = SIZE_PRESETS[sizeKey];
  if (!preset) {
    throw new Error(`Unknown fixture size: ${sizeKey}`);
  }

  const eventsPerFile = preset.events / preset.files;
  if (!Number.isInteger(eventsPerFile)) {
    throw new Error(`Fixture size ${sizeKey} must divide evenly into files`);
  }

  const specialCount = preset.specialFiles * eventsPerFile;
  const mainCount = preset.events - specialCount;
  const rng = mulberry32(0x5eed_077b);
  const { mainTimestamps, specialTimestamps } = buildTimestamps(mainCount, specialCount, rng);
  const allTimestamps = [...mainTimestamps, ...specialTimestamps];

  if (allTimestamps.length !== preset.events) {
    throw new Error(
      `Timestamp count ${allTimestamps.length} != expected ${preset.events} for ${sizeKey}`,
    );
  }

  const piDir = path.join(tmpDir, 'pi');
  mkdirSync(piDir, { recursive: true });

  const events = [];
  const fileList = [];

  for (let fileIndex = 0; fileIndex < preset.files; fileIndex += 1) {
    const sessionId = `pi-bench-${String(fileIndex).padStart(5, '0')}`;
    const lines = [];
    const firstEventIndex = fileIndex * eventsPerFile;
    const firstMix = MODEL_MIX[firstEventIndex % MODEL_MIX.length];

    lines.push(
      JSON.stringify({
        type: 'session',
        id: sessionId,
        timestamp: iso(allTimestamps[firstEventIndex]),
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'model_change',
        provider: firstMix.rawProvider,
        modelId: firstMix.model,
      }),
    );

    for (let offset = 0; offset < eventsPerFile; offset += 1) {
      const eventIndex = firstEventIndex + offset;
      const mix = MODEL_MIX[eventIndex % MODEL_MIX.length];
      const timestampMs = allTimestamps[eventIndex];
      const timestampIso = iso(timestampMs);
      const inputTokens = 100 + Math.floor(rng() * 900);
      const outputTokens = 50 + Math.floor(rng() * 450);
      const totalTokens = inputTokens + outputTokens;
      const costUsd = Number((totalTokens * 0.000015).toFixed(6));

      lines.push(
        JSON.stringify({
          type: 'message',
          timestamp: timestampIso,
          provider: mix.rawProvider,
          model: mix.model,
          usage: {
            input: inputTokens,
            output: outputTokens,
            totalTokens,
            cost: { total: costUsd },
          },
        }),
      );

      // Canonical normalized view: provider is the billing entity and model is
      // lower-cased, mirroring what the store writes and reads back.
      events.push({
        source: 'pi',
        sessionId,
        timestamp: timestampIso,
        provider: mix.billingProvider,
        model: mix.model.toLowerCase(),
        totalTokens,
      });
    }

    const filePath = path.join(piDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
    fileList.push({ fileIndex, filePath });
  }

  return {
    piDir,
    events,
    fileList,
    eventsPerFile,
    specialFiles: preset.specialFiles,
    totalEvents: preset.events,
    totalFiles: preset.files,
  };
}

function providerMatches(billingProvider, providerFilter) {
  if (!providerFilter) {
    return true;
  }
  return billingProvider.includes(providerFilter);
}

function withinDates(dateKey, since, until) {
  if (since && dateKey < since) {
    return false;
  }
  if (until && dateKey > until) {
    return false;
  }
  return true;
}

/**
 * Independent expected result for a scenario: provider + local-date filter
 * (Intl oracle), then exact/substring model resolution against the survivors —
 * matching production semantics without reusing the production code path.
 */
export function computeExpected(events, scenario) {
  const timezone = scenario.timezone;
  const providerDateFiltered = events.filter(
    (event) =>
      providerMatches(event.provider, scenario.provider) &&
      withinDates(localDateKey(event.timestamp, timezone), scenario.since, scenario.until),
  );

  let matched = providerDateFiltered;

  if (scenario.model && scenario.model.length > 0) {
    const available = new Set(providerDateFiltered.map((event) => event.model));
    const rules = scenario.model.map((value) => {
      const normalized = value.toLowerCase();
      return { value: normalized, mode: available.has(normalized) ? 'exact' : 'substring' };
    });
    matched = providerDateFiltered.filter((event) =>
      rules.some((rule) =>
        rule.mode === 'exact' ? event.model === rule.value : event.model.includes(rule.value),
      ),
    );
  }

  const tokenTotal = matched.reduce((sum, event) => sum + event.totalTokens, 0);

  return {
    count: matched.length,
    tokenTotal,
    fraction: events.length === 0 ? 0 : matched.length / events.length,
  };
}

// A scenario slice's since/until, in the main band, expressed as UTC dates.
function mainBandDate(dayOffset) {
  return new Date(MAIN_BAND_START_MS + dayOffset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Scenario matrix. Windowed tiers (UTC) drive the frozen thresholds; the
 * special scenarios exercise timezone/DST/model/provider correctness.
 */
export function buildScenarios(sizeKey) {
  const windowed = [
    {
      name: 'tier100-unfiltered',
      tier: '100%',
      kind: 'window',
      measured: true,
      timezone: 'UTC',
    },
    {
      name: 'tier50-half',
      tier: '50%',
      kind: 'window',
      measured: true,
      timezone: 'UTC',
      since: mainBandDate(0),
      until: mainBandDate(49),
    },
    {
      name: 'tier10-tenday',
      tier: '10%',
      kind: 'window',
      measured: true,
      timezone: 'UTC',
      since: mainBandDate(45),
      until: mainBandDate(54),
    },
    {
      name: 'tier1-oneday',
      tier: '1%',
      kind: 'window',
      measured: true,
      timezone: 'UTC',
      since: mainBandDate(50),
      until: mainBandDate(50),
    },
  ];

  const special = [
    {
      name: 'utc-narrow',
      kind: 'special',
      measured: false,
      timezone: 'UTC',
      since: '2026-01-15',
      until: '2026-01-15',
    },
    {
      name: 'paris-ordinary',
      kind: 'special',
      measured: false,
      timezone: 'Europe/Paris',
      since: '2026-06-15',
      until: '2026-06-15',
    },
    {
      name: 'paris-dst-week',
      kind: 'special',
      measured: false,
      timezone: 'Europe/Paris',
      since: '2026-03-28',
      until: '2026-03-30',
    },
    {
      name: 'saopaulo-historical',
      kind: 'special',
      measured: false,
      timezone: 'America/Sao_Paulo',
      since: '2019-02-16',
      until: '2019-02-16',
    },
    {
      name: 'provider-openai',
      kind: 'special',
      measured: false,
      timezone: 'UTC',
      provider: 'openai',
    },
    {
      name: 'model-exact-gpt41',
      kind: 'special',
      measured: false,
      timezone: 'UTC',
      model: ['gpt-4.1'],
    },
    {
      name: 'model-substring-claude',
      kind: 'special',
      measured: false,
      timezone: 'UTC',
      model: ['claude'],
    },
  ];

  const history = [
    {
      name: 'history-30',
      kind: 'history',
      measured: false,
      timezone: 'UTC',
      departedFraction: 0.3,
    },
  ];

  if (sizeKey === 'medium' || sizeKey === 'large') {
    history.push({
      name: 'history-50',
      kind: 'history',
      measured: false,
      timezone: 'UTC',
      departedFraction: 0.5,
    });
  }

  return { windowed, special, history };
}
