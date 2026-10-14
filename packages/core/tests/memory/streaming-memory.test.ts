import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { zstdCompressSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  dshAssistantMessageFixture,
  dshSessionHeader,
} from '../fixtures/dsh/dsh-session-fixtures.js';
import { encodeAntigravityGenMetadataBlob } from '../helpers/antigravity-fixtures.js';
import { mulberry32 } from '../helpers/seeded-random.js';
import { requireDatabaseSync } from '../helpers/sqlite.js';

// Peak RSS of a child that reads one large synthetic file through an adapter's `read`,
// counting events and summing tokens without keeping them. Each case runs at N and 2N,
// three times each: 2N must stay under an absolute ceiling, and the median peak may grow
// from N to 2N only by the state the reader documents. The fixtures are written to a temp
// dir (several GB in total, one case at a time), so the test only runs on request.
const enabled = process.env.CORE_MEMORY_TEST === '1';

const execFileAsync = promisify(execFile);
const distSourcesRoot = fileURLToPath(new URL('../../dist/sources', import.meta.url));
const MiB = 1024 * 1024;
const KiB_PER_MiB = 1024;
const RUNS_PER_SIZE = 3;
const CASE_TIMEOUT_MS = 15 * 60 * 1000;

// Reads through `read` only. `lastModel` keeps one string, not the event.
const CHILD_SCRIPT = `
import { pathToFileURL } from 'node:url';
const [modulePath, exportName, optionsJson, filePath] = process.argv.slice(1);
const module = await import(pathToFileURL(modulePath).href);
const adapter = new module[exportName](JSON.parse(optionsJson));
const diagnostics = { skippedRows: 0, skippedRowReasons: new Map() };
let events = 0;
let totalTokens = 0;
let lastModel;
for await (const event of adapter.read(filePath, { diagnostics })) {
  events += 1;
  totalTokens += event.totalTokens;
  lastModel = event.model;
}
process.stdout.write(JSON.stringify({
  events,
  totalTokens,
  lastModel,
  skippedRows: diagnostics.skippedRows,
  maxRssKiB: process.resourceUsage().maxRSS,
}));
`;

type ChildResult = {
  events: number;
  totalTokens: number;
  lastModel?: string;
  skippedRows: number;
  maxRssKiB: number;
};

type Fixture = {
  /** The path handed to `read`. */
  readPath: string;
  /** Files to measure for the disk-usage line. */
  files: string[];
  events: number;
  totalTokens: number;
  lastModel?: string;
};

type MemoryCase = {
  name: string;
  sourceId: string;
  exportName: string;
  options: (dir: string) => Record<string, unknown>;
  /** Writes the fixture for `scale` (1 = N, 2 = 2N) under `dir`. */
  generate: (dir: string, scale: 1 | 2) => Promise<Fixture>;
  /** Checks on the 2N fixture's size, so a shrunken generator cannot pass. */
  checkFixture: (fixture: Fixture, sizes: number[]) => void;
  ceilingKiB: number;
  growthAllowanceKiB: number;
};

/** Writes the strings to a file in ~1 MiB writes, never holding more than one batch. */
async function writeTextStreamed(filePath: string, parts: Iterable<string>): Promise<void> {
  const handle = await open(filePath, 'w');
  let batch: string[] = [];
  let batchLength = 0;

  try {
    for (const part of parts) {
      batch.push(part);
      batchLength += part.length;

      if (batchLength >= MiB) {
        await handle.write(batch.join(''));
        batch = [];
        batchLength = 0;
      }
    }

    await handle.write(batch.join(''));
  } finally {
    await handle.close();
  }
}

/** Creates a SQLite database with `schema` and inserts `rowCount` rows, 50k per transaction. */
function writeDatabase(
  dbPath: string,
  schema: string,
  insertSql: string,
  rowCount: number,
  rowValues: (index: number) => unknown[],
): void {
  const database = new (requireDatabaseSync())(dbPath);

  try {
    database.exec('PRAGMA synchronous = OFF');
    database.exec(schema);
    const insert = database.prepare(insertSql);

    for (let index = 0; index < rowCount; index += 1) {
      if (index % 50_000 === 0) {
        if (index > 0) {
          database.exec('COMMIT');
        }

        database.exec('BEGIN');
      }

      insert.run(...rowValues(index));
    }

    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

const BASE_TIME_MS = Date.parse('2026-03-01T00:00:00.000Z');

// codex: `event_msg`/`token_count` lines with cumulative totals, as Codex writes them.
const CODEX_EVENTS_AT_N = 500_000;

function codexUsage(index: number) {
  const input = 1_000 + (index % 97);
  const cached = 200 + (index % 13);
  const output = 300 + (index % 31);
  const reasoning = 50 + (index % 7);
  return { input, cached, output, reasoning, total: input + output };
}

function* codexLines(events: number): Generator<string> {
  yield `${JSON.stringify({
    timestamp: new Date(BASE_TIME_MS).toISOString(),
    type: 'session_meta',
    payload: { id: 'codex-memory-session', model_provider: 'openai' },
  })}\n`;
  yield `${JSON.stringify({
    timestamp: new Date(BASE_TIME_MS).toISOString(),
    type: 'turn_context',
    payload: { model: 'gpt-5.2-codex' },
  })}\n`;

  const totals = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };

  for (let index = 0; index < events; index += 1) {
    const last = codexUsage(index);
    totals.input += last.input;
    totals.cached += last.cached;
    totals.output += last.output;
    totals.reasoning += last.reasoning;
    totals.total += last.total;
    const timestamp = new Date(BASE_TIME_MS + index * 1_000).toISOString();

    yield `{"timestamp":"${timestamp}","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":${totals.input},"cached_input_tokens":${totals.cached},"output_tokens":${totals.output},"reasoning_output_tokens":${totals.reasoning},"total_tokens":${totals.total}},"last_token_usage":{"input_tokens":${last.input},"cached_input_tokens":${last.cached},"output_tokens":${last.output},"reasoning_output_tokens":${last.reasoning},"total_tokens":${last.total}},"model_context_window":272000},"rate_limits":{"limit_id":"codex","primary":{"used_percent":${index % 100},"window_minutes":300,"resets_at":${1_772_000_000 + index}},"secondary":{"used_percent":${index % 50},"window_minutes":10080,"resets_at":${1_772_600_000 + index}},"plan_type":"pro"}}}\n`;
  }
}

async function generateCodex(dir: string, scale: 1 | 2): Promise<Fixture> {
  const events = CODEX_EVENTS_AT_N * scale;
  const filePath = path.join(dir, `rollout-memory-${scale}n.jsonl`);
  await writeTextStreamed(filePath, codexLines(events));
  let totalTokens = 0;

  for (let index = 0; index < events; index += 1) {
    totalTokens += codexUsage(index).total;
  }

  return { readPath: filePath, files: [filePath], events, totalTokens };
}

// dsh: frames of incompressible lines, each frame free of a stray magic after position 0.
const DSH_FRAMES_AT_N = 2_100;
const DSH_LINES_PER_FRAME = 32;
const DSH_PAYLOAD_BYTES = 1_500;
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dshUsage(lineIndex: number) {
  const inputTokens = 500 + (lineIndex % 89);
  const outputTokens = 100 + (lineIndex % 23);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function randomPayload(seed: number): string {
  const random = mulberry32(seed);
  const bytes = Buffer.allocUnsafe(DSH_PAYLOAD_BYTES);

  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes.writeUInt32LE(Math.floor(random() * 0x1_0000_0000), offset);
  }

  return bytes.toString('base64');
}

function dshFrameText(frameIndex: number, seed: number): string {
  const lines: string[] = [];

  if (frameIndex === 0) {
    lines.push(
      JSON.stringify(dshSessionHeader({ id: 'dsh-memory-session', createdAt: BASE_TIME_MS })),
    );
  }

  for (let line = 0; line < DSH_LINES_PER_FRAME; line += 1) {
    const lineIndex = frameIndex * DSH_LINES_PER_FRAME + line;
    lines.push(
      JSON.stringify(
        dshAssistantMessageFixture({
          seq: lineIndex + 1,
          time: BASE_TIME_MS + lineIndex * 1_000,
          usage: dshUsage(lineIndex),
          text: randomPayload(seed * DSH_LINES_PER_FRAME + line),
        }),
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}

async function generateDsh(dir: string, scale: 1 | 2): Promise<Fixture> {
  const frames = DSH_FRAMES_AT_N * scale;
  const filePath = path.join(dir, `dsh-${scale}n`, 'session.v3.jsonl.zstd');
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'w');
  let seed = 1;

  try {
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      // Compressed bytes depend on the zstd each Node bundles: a frame whose bytes happen
      // to hold the magic would be cut in two by the reader, so it is regenerated.
      let compressed: Buffer;

      do {
        compressed = zstdCompressSync(dshFrameText(frameIndex, seed));
        seed += 1;
      } while (compressed.includes(ZSTD_FRAME_MAGIC, 1));

      await handle.write(compressed);
    }
  } finally {
    await handle.close();
  }

  const events = frames * DSH_LINES_PER_FRAME;
  let totalTokens = 0;

  for (let index = 0; index < events; index += 1) {
    totalTokens += dshUsage(index).totalTokens;
  }

  return { readPath: filePath, files: [filePath], events, totalTokens };
}

// SQLite cases: 2N = 1M rows each.
const SQLITE_ROWS_AT_N = 500_000;

function openCodeUsage(index: number) {
  const input = 400 + (index % 71);
  const output = 90 + (index % 19);
  const cacheRead = 50 + (index % 11);
  return { input, output, cacheRead, total: input + output + cacheRead };
}

async function generateOpenCode(dir: string, scale: 1 | 2): Promise<Fixture> {
  const rows = SQLITE_ROWS_AT_N * scale;
  const dbPath = path.join(dir, `opencode-${scale}n.db`);
  // The schema of the e2e fixture helper (tests/helpers/opencode-fixtures.ts).
  writeDatabase(
    dbPath,
    `
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE part (id TEXT PRIMARY KEY);
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `,
    'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    rows,
    (index) => {
      const usage = openCodeUsage(index);
      return [
        `msg-${String(index).padStart(8, '0')}`,
        `session-${index % 1_000}`,
        BASE_TIME_MS + index * 1_000,
        JSON.stringify({
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-4.1-opencode',
          tokens: {
            input: usage.input,
            output: usage.output,
            reasoning: 0,
            cache: { read: usage.cacheRead, write: 0 },
            total: usage.total,
          },
        }),
      ];
    },
  );
  let totalTokens = 0;

  for (let index = 0; index < rows; index += 1) {
    totalTokens += openCodeUsage(index).total;
  }

  return { readPath: dbPath, files: [dbPath], events: rows, totalTokens };
}

function gooseUsage(index: number) {
  const input = 700 + (index % 53);
  const output = 150 + (index % 29);
  return { input, output, total: input + output };
}

async function generateGoose(dir: string, scale: 1 | 2): Promise<Fixture> {
  const rows = SQLITE_ROWS_AT_N * scale;
  const dbPath = path.join(dir, `goose-${scale}n.db`);
  // The schema of the goose adapter test's fixture helper.
  writeDatabase(
    dbPath,
    `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        model_config_json TEXT,
        provider_name TEXT,
        created_at TEXT,
        total_tokens INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        accumulated_total_tokens INTEGER,
        accumulated_input_tokens INTEGER,
        accumulated_output_tokens INTEGER
      );
    `,
    `INSERT INTO sessions (
      id, model_config_json, provider_name, created_at, total_tokens, input_tokens,
      output_tokens, accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows,
    (index) => {
      const usage = gooseUsage(index);
      return [
        `goose-${String(index).padStart(8, '0')}`,
        JSON.stringify({ model_name: 'gpt-goose' }),
        'openai',
        new Date(BASE_TIME_MS + index * 1_000).toISOString(),
        usage.total,
        usage.input,
        usage.output,
        null,
        null,
        null,
      ];
    },
  );
  let totalTokens = 0;

  for (let index = 0; index < rows; index += 1) {
    totalTokens += gooseUsage(index).total;
  }

  return { readPath: dbPath, files: [dbPath], events: rows, totalTokens };
}

// antigravity: ~1 KB blobs. The padding is an unknown length-delimited field (15) after
// the chat model, which the parser skips, so a reader buffering rows would hold ~1 KB per
// row against the ~tens of bytes per response id its Set keeps.
const ANTIGRAVITY_PADDING_BYTES = 960;
const ANTIGRAVITY_PADDING_FIELD = Buffer.concat([
  Buffer.from([
    15 * 8 + 2,
    (ANTIGRAVITY_PADDING_BYTES & 0x7f) | 0x80,
    ANTIGRAVITY_PADDING_BYTES >> 7,
  ]),
  Buffer.alloc(ANTIGRAVITY_PADDING_BYTES, 0x61),
]);

function antigravityUsage(index: number) {
  const inputTokens = 800 + (index % 61);
  const totalOutputTokens = 200 + (index % 37);
  const cacheReadTokens = 100 + (index % 17);
  return {
    inputTokens,
    totalOutputTokens,
    cacheReadTokens,
    total: inputTokens + totalOutputTokens + cacheReadTokens,
  };
}

async function generateAntigravity(dir: string, scale: 1 | 2): Promise<Fixture> {
  const rows = SQLITE_ROWS_AT_N * scale;
  const dbPath = path.join(dir, `antigravity-${scale}n.db`);
  // The gen_metadata schema of tests/helpers/antigravity-fixtures.ts.
  writeDatabase(
    dbPath,
    'CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);',
    'INSERT INTO gen_metadata (idx, data) VALUES (?, ?)',
    rows,
    (index) => {
      const usage = antigravityUsage(index);
      const blob = encodeAntigravityGenMetadataBlob({
        model: 'gemini-3-pro',
        timestamp: { seconds: BASE_TIME_MS / 1_000 + index },
        usage: {
          inputTokens: usage.inputTokens,
          totalOutputTokens: usage.totalOutputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          responseId: `response-${index}`,
        },
      });
      return [index, Buffer.concat([blob, ANTIGRAVITY_PADDING_FIELD])];
    },
  );
  let totalTokens = 0;

  for (let index = 0; index < rows; index += 1) {
    totalTokens += antigravityUsage(index).total;
  }

  return { readPath: dbPath, files: [dbPath], events: rows, totalTokens };
}

// cline: ui_messages.json just under 64 MiB at 2N, and a history file of 200+ MB whose last
// complete <environment_details> block names the model.
const CLINE_REQUESTS_AT_N = 52_000;
const CLINE_TEXT_PADDING = 'All set. '.repeat(44);
const CLINE_HISTORY_ENTRIES_AT_N = 800;
const CLINE_HISTORY_FILLER = 'Reading the repository layout before editing files. '.repeat(1_260);
const CLINE_MODEL = 'claude-memory-model';

function clineUsage(index: number) {
  const tokensIn = 300 + (index % 43);
  const tokensOut = 80 + (index % 17);
  const cacheReads = 40 + (index % 7);
  const cacheWrites = 10 + (index % 5);
  return {
    tokensIn,
    tokensOut,
    cacheReads,
    cacheWrites,
    total: tokensIn + tokensOut + cacheReads + cacheWrites,
  };
}

function* clineUiMessages(requests: number): Generator<string> {
  yield '[\n';

  for (let index = 0; index < requests; index += 1) {
    const usage = clineUsage(index);
    const ts = BASE_TIME_MS + index * 2_000;
    const request = JSON.stringify({
      type: 'say',
      say: 'api_req_started',
      ts,
      text: JSON.stringify({
        cost: 0.01,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        cacheReads: usage.cacheReads,
        cacheWrites: usage.cacheWrites,
        apiProtocol: 'anthropic',
      }),
    });
    const reply = JSON.stringify({
      type: 'say',
      say: 'text',
      ts: ts + 1_000,
      text: CLINE_TEXT_PADDING,
    });
    yield `${index === 0 ? '' : ',\n'}${request},\n${reply}`;
  }

  yield '\n]\n';
}

function* clineHistory(entries: number): Generator<string> {
  yield '[\n';

  for (let index = 0; index < entries; index += 1) {
    const model = index === entries - 1 ? CLINE_MODEL : `claude-older-model-${index}`;
    const user = JSON.stringify({
      role: 'user',
      content: `<environment_details>\n<model>${model}</model>\n</environment_details>\n${CLINE_HISTORY_FILLER}`,
    });
    const assistant = JSON.stringify({ role: 'assistant', content: CLINE_HISTORY_FILLER });
    yield `${index === 0 ? '' : ',\n'}${user},\n${assistant}`;
  }

  yield '\n]\n';
}

async function generateCline(dir: string, scale: 1 | 2): Promise<Fixture> {
  const taskDir = path.join(dir, `cline-${scale}n`, `task-memory-${scale}n`);
  await mkdir(taskDir, { recursive: true });
  const uiMessagesPath = path.join(taskDir, 'ui_messages.json');
  const historyPath = path.join(taskDir, 'api_conversation_history.json');
  const requests = CLINE_REQUESTS_AT_N * scale;
  await writeTextStreamed(uiMessagesPath, clineUiMessages(requests));
  await writeTextStreamed(historyPath, clineHistory(CLINE_HISTORY_ENTRIES_AT_N * scale));
  let totalTokens = 0;

  for (let index = 0; index < requests; index += 1) {
    totalTokens += clineUsage(index).total;
  }

  return {
    readPath: uiMessagesPath,
    files: [uiMessagesPath, historyPath],
    events: requests,
    totalTokens,
    lastModel: CLINE_MODEL,
  };
}

const CASES: MemoryCase[] = [
  {
    name: 'codex JSONL',
    sourceId: 'codex',
    exportName: 'CodexSourceAdapter',
    options: (dir) => ({ dir }),
    generate: generateCodex,
    checkFixture: (fixture, [size]) => {
      expect(size).toBeGreaterThanOrEqual(500_000_000);
      expect(fixture.events).toBeGreaterThanOrEqual(1_000_000);
    },
    // Peaks 135-149 MiB on Node 22.16 and 24. No token_usage_record lines, so the response
    // id Set and pending records stay empty: growth is noise (3-11 MiB), against the ~300 MiB
    // a buffering reader would add.
    ceilingKiB: 192 * KiB_PER_MiB,
    growthAllowanceKiB: 32 * KiB_PER_MiB,
  },
  {
    name: 'dsh zstd',
    sourceId: 'dsh',
    exportName: 'DshSourceAdapter',
    options: (dir) => ({ dir }),
    generate: generateDsh,
    checkFixture: (_fixture, [size]) => {
      expect(size).toBeGreaterThanOrEqual(200_000_000);
    },
    // Peaks 123-145 MiB. One compressed frame (~50 KB) and its decoded text at a time:
    // growth is under 4 MiB, against the ~98 MiB of compressed input N adds.
    ceilingKiB: 192 * KiB_PER_MiB,
    growthAllowanceKiB: 16 * KiB_PER_MiB,
  },
  {
    name: 'opencode SQLite',
    sourceId: 'opencode',
    exportName: 'OpenCodeSourceAdapter',
    options: () => ({}),
    generate: generateOpenCode,
    checkFixture: (fixture) => {
      expect(fixture.events).toBe(1_000_000);
    },
    // Peaks 82-91 MiB. One row at a time; SQLite's ORDER BY sorter spills past its cache, and
    // an index on (time_created, id) changes neither the peak nor the time much.
    ceilingKiB: 128 * KiB_PER_MiB,
    growthAllowanceKiB: 16 * KiB_PER_MiB,
  },
  {
    name: 'goose SQLite',
    sourceId: 'goose',
    exportName: 'GooseSourceAdapter',
    options: () => ({}),
    generate: generateGoose,
    checkFixture: (fixture) => {
      expect(fixture.events).toBe(1_000_000);
    },
    // Peaks 79-88 MiB. One row at a time: growth is under 7 MiB.
    ceilingKiB: 128 * KiB_PER_MiB,
    growthAllowanceKiB: 16 * KiB_PER_MiB,
  },
  {
    name: 'antigravity SQLite',
    sourceId: 'antigravity',
    exportName: 'AntigravitySourceAdapter',
    options: (dir) => ({ dir }),
    generate: generateAntigravity,
    checkFixture: (fixture, [size]) => {
      expect(fixture.events).toBe(1_000_000);
      expect(size).toBeGreaterThanOrEqual(1_000_000_000);
    },
    // The documented state is the Set of seen response ids: 500k more ids grow the median
    // peak by 35-39 MiB on Node 24 and 62-85 MiB on Node 22.16 (old-space headroom over
    // ~58 MB live at 1M ids), with 2N peaks of 189-194 MiB and 222-248 MiB; without ids the
    // read stays at ~100 MiB. Buffering the rows would add ~480 MiB.
    ceilingKiB: 256 * KiB_PER_MiB,
    growthAllowanceKiB: 112 * KiB_PER_MiB,
  },
  {
    name: 'cline task',
    sourceId: 'cline',
    exportName: 'ClineFamilyAdapter',
    options: (dir) => ({ id: 'cline', extensionId: 'saoudrizwan.claude-dev', dir }),
    generate: generateCline,
    checkFixture: (fixture, [uiMessagesSize, historySize]) => {
      expect(uiMessagesSize).toBeLessThan(64 * MiB);
      expect(fixture.events).toBeGreaterThanOrEqual(100_000);
      expect(historySize).toBeGreaterThanOrEqual(200_000_000);
    },
    // Peaks 126-152 MiB, single N runs on Node 22.16 spreading 27 MiB. One ui_messages
    // element and the history scanner's carried text at a time: median growth -14 to 10 MiB,
    // against the ~32 + 100 MiB of input N adds.
    ceilingKiB: 192 * KiB_PER_MiB,
    growthAllowanceKiB: 32 * KiB_PER_MiB,
  },
];

async function runChild(memoryCase: MemoryCase, dir: string, home: string, readPath: string) {
  const modulePath = path.join(distSourcesRoot, memoryCase.sourceId, 'index.js');
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      // Node 24 grows the young generation from 64 to 128 MiB after enough garbage,
      // whatever the input size; Node 22 keeps 32 MiB. Pinning it to Node 22's size keeps
      // that heuristic out of the peaks, which then show only what the reader holds.
      '--max-semi-space-size=16',
      '--input-type=module',
      '-e',
      CHILD_SCRIPT,
      modulePath,
      memoryCase.exportName,
      JSON.stringify(memoryCase.options(dir)),
      readPath,
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1' },
      maxBuffer: MiB,
    },
  );

  return JSON.parse(stdout) as ChildResult;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

describe.runIf(enabled)('streaming read memory', () => {
  it.each(CASES)(
    '$name: peak RSS stays under its ceiling and does not grow with the input',
    async (memoryCase) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), `core-memory-${memoryCase.sourceId}-`));

      try {
        const home = path.join(dir, 'home');
        await mkdir(home);
        const startedAt = performance.now();
        const fixtures = {
          1: await memoryCase.generate(dir, 1),
          2: await memoryCase.generate(dir, 2),
        };
        const generatedAt = performance.now();
        const sizes = {
          1: await Promise.all(fixtures[1].files.map(async (file) => (await stat(file)).size)),
          2: await Promise.all(fixtures[2].files.map(async (file) => (await stat(file)).size)),
        };
        memoryCase.checkFixture(fixtures[2], sizes[2]);
        const peaks: Record<1 | 2, number[]> = { 1: [], 2: [] };

        // N and 2N alternate, so drift on the machine lands on both sizes.
        for (let run = 0; run < RUNS_PER_SIZE; run += 1) {
          for (const scale of [1, 2] as const) {
            const fixture = fixtures[scale];
            const result = await runChild(memoryCase, dir, home, fixture.readPath);
            expect(result).toMatchObject({
              events: fixture.events,
              totalTokens: fixture.totalTokens,
              skippedRows: 0,
              ...(fixture.lastModel === undefined ? {} : { lastModel: fixture.lastModel }),
            });
            peaks[scale].push(result.maxRssKiB);
          }
        }

        const growthKiB = median(peaks[2]) - median(peaks[1]);
        const toMiB = (bytes: number) => (bytes / MiB).toFixed(1);
        console.log(
          [
            `[memory] ${memoryCase.name} on Node ${process.versions.node}:`,
            `N peaks ${peaks[1].join('/')} KiB, 2N peaks ${peaks[2].join('/')} KiB,`,
            `median growth ${growthKiB} KiB`,
            `(ceiling ${memoryCase.ceilingKiB} KiB, allowance ${memoryCase.growthAllowanceKiB} KiB);`,
            `fixtures N ${sizes[1].map(toMiB).join('+')} MiB, 2N ${sizes[2].map(toMiB).join('+')} MiB;`,
            `generate ${((generatedAt - startedAt) / 1000).toFixed(1)} s,`,
            `runs ${((performance.now() - generatedAt) / 1000).toFixed(1)} s`,
          ].join(' '),
        );

        expect(Math.max(...peaks[2])).toBeLessThanOrEqual(memoryCase.ceilingKiB);
        expect(growthKiB).toBeLessThanOrEqual(memoryCase.growthAllowanceKiB);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CASE_TIMEOUT_MS,
  );
});
