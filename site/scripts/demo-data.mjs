// Synthetic agent logs for the docs screenshots and the demo report. Four sources in their
// on-disk formats and default locations under a home directory (Claude Code, Codex, pi,
// Gemini CLI), four projects under `<home>/code`, about 90 days ending at the run time, with
// nothing later than it. Same seed and run time give the same files. Nothing here comes from
// real logs.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEMO_SOURCES = ['claude', 'codex', 'pi', 'gemini'];
export const DEMO_PROJECTS = ['atlas-api', 'web-console', 'ingest-worker', 'docs-site'];
export const DEMO_DAYS = 90;

const DAY_MS = 86_400_000;
// The latest session start (21:59) plus the longest gap before its first request fit in 23
// hours, so squeezing the run date's schedule into the time elapsed since midnight keeps at
// least one request at or before the run time.
const SCHEDULE_MS = 23 * 3_600_000;

// Relative weight of each project per source, in DEMO_PROJECTS order.
const PROJECT_WEIGHTS = {
  claude: [5, 3, 2, 1],
  codex: [2, 4, 3, 1],
  pi: [1, 2, 4, 2],
  gemini: [1, 1, 2, 4],
};

const MODELS = {
  claude: [
    { id: 'claude-sonnet-4-5', weight: 6 },
    { id: 'claude-opus-4-5', weight: 2 },
    { id: 'claude-haiku-4-5', weight: 2 },
  ],
  codex: [
    { id: 'gpt-5.2-codex', weight: 5 },
    { id: 'gpt-5.1-codex-mini', weight: 2 },
  ],
  pi: [
    { id: 'claude-sonnet-4-5', provider: 'anthropic', weight: 3 },
    { id: 'gpt-5.2', provider: 'openai', weight: 2 },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', weight: 3 },
    { id: 'gemini-2.5-flash', weight: 2 },
  ],
};

// Mean sessions per weekday for each source; weekends get a third.
const SESSIONS_PER_DAY = { claude: 2.4, codex: 1.6, pi: 0.9, gemini: 0.6 };

const TITLES = [
  'Add retry with backoff to the webhook client',
  'Fix flaky pagination test',
  'Migrate config loader to the new schema',
  'Speed up the ingest batch writer',
  'Write the release notes draft',
  'Refactor auth middleware',
  'Add CSV export to the usage table',
  'Investigate memory growth in the worker',
  'Tidy up the docs sidebar',
  'Port date helpers to Temporal',
];

/** Mulberry32: a small seeded PRNG, so the same seed gives the same logs. */
export function createRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items, weights) => {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let roll = next() * total;
      for (let index = 0; index < items.length; index += 1) {
        roll -= weights[index];
        if (roll < 0) return items[index];
      }
      return items[items.length - 1];
    },
    hex: (length) => Array.from({ length }, () => int(0, 15).toString(16)).join(''),
    // Poisson count by inversion; fine for the small means used here.
    count: (mean) => {
      const limit = Math.exp(-mean);
      let product = next();
      let result = 0;
      while (product > limit) {
        product *= next();
        result += 1;
      }
      return result;
    },
  };
}

function uuid(random) {
  const h = random.hex(32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

function toDateKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/** The UTC day starts of the `days` days ending on `endDate` (YYYY-MM-DD), oldest first. */
function dayStarts(endDate, days) {
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(end)) throw new Error(`Invalid end date: ${endDate} (expected YYYY-MM-DD)`);
  return Array.from({ length: days }, (_, index) => end - (days - 1 - index) * DAY_MS);
}

/**
 * Sessions of one source: start time, project, model, request times. On the run date the
 * schedule is scaled into the time between midnight and `now`, so that day has usage at any
 * run time.
 */
function planSessions(random, source, starts, now) {
  const sessions = [];
  const last = starts.length - 1;

  starts.forEach((dayStart, dayIndex) => {
    const weekday = new Date(dayStart).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // Usage grows a little over the window, and the run date always has some activity.
    const growth = 0.7 + (0.6 * dayIndex) / last;
    const mean = SESSIONS_PER_DAY[source] * growth * (weekend ? 0.33 : 1);
    const count = dayIndex === last ? Math.max(2, random.count(mean)) : random.count(mean);
    const scale = dayIndex === last ? Math.min(1, (now - dayStart) / SCHEDULE_MS) : 1;

    for (let index = 0; index < count; index += 1) {
      const hour = random.weighted(
        [7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 19, 21],
        [1, 3, 4, 4, 3, 3, 4, 4, 3, 2, 1, 1],
      );
      let offset = (hour * 3_600_000 + random.int(0, 59) * 60_000) * scale;
      const requests = random.int(6, 36);
      const times = [];
      for (let request = 0; request < requests; request += 1) {
        offset += random.int(20, 240) * 1000 * scale;
        times.push(dayStart + Math.floor(offset));
      }
      const model = random.weighted(
        MODELS[source],
        MODELS[source].map((entry) => entry.weight),
      );
      sessions.push({
        // Each session draws its tokens from its own generator, so cutting one short at the
        // run time leaves every other session as the seed made it.
        seed: random.int(0, 2_147_483_647),
        id: uuid(random),
        project: random.weighted(DEMO_PROJECTS, PROJECT_WEIGHTS[source]),
        model,
        title: random.pick(TITLES),
        times,
      });
    }
  });

  return sessions;
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function claudeSession(random, session, cwd) {
  const rows = [
    {
      type: 'user',
      timestamp: new Date(session.times[0] - 5000).toISOString(),
      sessionId: session.id,
      cwd,
      uuid: uuid(random),
      message: { role: 'user', content: session.title },
    },
    { type: 'ai-title', sessionId: session.id, aiTitle: session.title },
  ];
  let context = random.int(12_000, 30_000);

  for (const time of session.times) {
    const created = random.next() < 0.3 ? random.int(1_000, 9_000) : random.int(0, 600);
    rows.push({
      type: 'assistant',
      timestamp: new Date(time).toISOString(),
      sessionId: session.id,
      cwd,
      uuid: uuid(random),
      requestId: `req_${random.hex(24)}`,
      message: {
        id: `msg_${random.hex(24)}`,
        role: 'assistant',
        model: session.model.id,
        usage: {
          input_tokens: random.int(2, 60),
          cache_creation_input_tokens: created,
          cache_read_input_tokens: context,
          output_tokens: random.int(120, 2_400),
        },
      },
    });
    context += created + random.int(500, 4_000);
  }

  return jsonl(rows);
}

function codexSession(random, session, cwd) {
  const first = new Date(session.times[0] - 3000).toISOString();
  const rows = [
    {
      timestamp: first,
      type: 'session_meta',
      payload: { id: session.id, cwd, model_provider: 'openai', originator: 'codex_cli_rs' },
    },
    { timestamp: first, type: 'turn_context', payload: { cwd, model: session.model.id } },
  ];
  const total = { input: 0, cached: 0, output: 0, reasoning: 0 };
  let context = random.int(15_000, 35_000);

  for (const time of session.times) {
    const input = context + random.int(400, 3_000);
    const cached = Math.floor(context * (0.8 + random.next() * 0.15));
    const output = random.int(150, 2_800);
    const reasoning = Math.floor(output * random.next() * 0.6);
    total.input += input;
    total.cached += cached;
    total.output += output;
    total.reasoning += reasoning;
    const usage = (values) => ({
      input_tokens: values.input,
      cached_input_tokens: values.cached,
      output_tokens: values.output,
      reasoning_output_tokens: values.reasoning,
      total_tokens: values.input + values.output,
    });
    rows.push({
      timestamp: new Date(time).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: usage(total),
          last_token_usage: usage({ input, cached, output, reasoning }),
        },
      },
    });
    context = input + output;
  }

  return jsonl(rows);
}

function piSession(random, session, cwd) {
  const { id: model, provider } = session.model;
  const rows = [
    {
      type: 'session',
      id: session.id,
      timestamp: new Date(session.times[0] - 4000).toISOString(),
      cwd,
    },
    { type: 'model_change', provider, modelId: model },
  ];
  let context = random.int(8_000, 20_000);

  for (const time of session.times) {
    const input = random.int(200, 2_500);
    // OpenAI bills no cache writes, so pi records none for it.
    const cacheWrite = provider === 'openai' ? 0 : random.int(0, 3_000);
    const output = random.int(100, 2_000);
    rows.push({
      type: 'message',
      timestamp: new Date(time).toISOString(),
      provider,
      model,
      role: 'assistant',
      usage: {
        input,
        output,
        cacheRead: context,
        cacheWrite,
        totalTokens: input + output + context + cacheWrite,
      },
    });
    context += cacheWrite + random.int(300, 2_000);
  }

  return jsonl(rows);
}

function geminiSession(random, session, projectName) {
  const messages = session.times.map((time) => {
    const input = random.int(6_000, 40_000);
    const cached = Math.floor(input * random.next() * 0.7);
    const output = random.int(150, 2_200);
    const thoughts = random.int(0, 1_500);
    return {
      type: 'gemini',
      timestamp: new Date(time).toISOString(),
      model: session.model.id,
      tokens: { input, output, thoughts, cached, tool: 0, total: input + output + thoughts },
    };
  });
  return `${JSON.stringify(
    {
      sessionId: session.id,
      projectHash: projectName,
      startTime: new Date(session.times[0] - 2000).toISOString(),
      lastUpdated: new Date(session.times.at(-1)).toISOString(),
      messages,
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes the demo logs under `home` (a temp directory used as HOME) and returns the directory
 * to pass for each source (`--source-dir <id>=<dir>`). `now` (epoch ms) is the run time: the
 * last day with data is its UTC date, and no event is later than it.
 */
export async function writeDemoData({ home, seed = 20_261_017, now, days = DEMO_DAYS }) {
  const random = createRandom(seed);
  const starts = dayStarts(toDateKey(now), days);
  const projectRoot = (name) => path.join(home, 'code', name);
  const dirs = {
    claude: path.join(home, '.claude', 'projects'),
    codex: path.join(home, '.codex', 'sessions'),
    pi: path.join(home, '.pi', 'agent', 'sessions'),
    gemini: path.join(home, '.gemini'),
  };
  const files = new Map();

  for (const name of DEMO_PROJECTS) {
    await mkdir(projectRoot(name), { recursive: true });
  }

  for (const source of DEMO_SOURCES) {
    for (const planned of planSessions(random, source, starts, now)) {
      const session = { ...planned, times: planned.times.filter((time) => time <= now) };
      if (session.times.length === 0) continue;
      const sessionRandom = createRandom(session.seed);
      const cwd = projectRoot(session.project);
      const day = toDateKey(session.times[0]);
      if (source === 'claude') {
        const file = path.join(dirs.claude, `-code-${session.project}`, `${session.id}.jsonl`);
        files.set(file, claudeSession(sessionRandom, session, cwd));
      } else if (source === 'codex') {
        const [year, month, date] = day.split('-');
        const stamp = new Date(session.times[0]).toISOString().slice(0, 19).replaceAll(':', '-');
        const file = path.join(
          dirs.codex,
          year,
          month,
          date,
          `rollout-${stamp}-${session.id}.jsonl`,
        );
        files.set(file, codexSession(sessionRandom, session, cwd));
      } else if (source === 'pi') {
        const file = path.join(
          dirs.pi,
          `--code-${session.project}--`,
          `${day}_${session.id}.jsonl`,
        );
        files.set(file, piSession(sessionRandom, session, cwd));
      } else {
        const file = path.join(
          dirs.gemini,
          'tmp',
          session.project,
          'chats',
          `session-${session.id}.json`,
        );
        files.set(file, geminiSession(sessionRandom, session, session.project));
      }
    }
  }

  const geminiProjects = Object.fromEntries(DEMO_PROJECTS.map((name) => [projectRoot(name), name]));
  files.set(
    path.join(dirs.gemini, 'projects.json'),
    `${JSON.stringify({ projects: geminiProjects }, null, 2)}\n`,
  );

  for (const [file, content] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  return { dirs, fileCount: files.size };
}
