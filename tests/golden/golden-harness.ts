import { realpathSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { format } from 'node:util';

import { afterAll, expect, vi } from 'vitest';

import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import { getSourceOverrideOptions } from '../../src/sources/create-default-adapters.js';
import {
  createAntigravityFixtureDb,
  E2E_ANTIGRAVITY_FIXTURE,
} from '../helpers/antigravity-fixtures.js';
import { createDshSessionsFixture } from '../helpers/dsh-fixtures.js';
import { createGooseFixtureDb, E2E_GOOSE_SESSIONS } from '../helpers/goose-fixtures.js';
import { createOpenCodeFixtureDb, E2E_OPENCODE_MESSAGES } from '../helpers/opencode-fixtures.js';

/** The day after the latest fixture event, so summary's windows hold June data. */
export const FIXED_NOW = new Date('2026-06-21T12:00:00.000Z');

export const GOLDENS_DIR = path.resolve('tests/golden/__goldens__');
export const WINDOWS_SKIP_REASON =
  'paths and newline handling differ on Windows; the Linux leg guards behaviour';

const FIXTURES_ROOT = path.resolve('tests/fixtures');
const E2E_FIXTURES_ROOT = path.join(FIXTURES_ROOT, 'e2e');
const GOLDEN_FIXTURES_ROOT = path.join(FIXTURES_ROOT, 'golden');

/**
 * Every registered source, in registration order. Written out rather than read from the
 * registry so that adding, dropping or renaming a source fails `orphans.golden.test.ts`
 * instead of silently adding or orphaning goldens.
 */
export const ALL_SOURCE_IDS: readonly string[] = [
  'pi',
  'codex',
  'gemini',
  'droid',
  'opencode',
  'openclaw',
  'claude',
  'copilot',
  'goose',
  'amp',
  'qwen',
  'kimi',
  'cline',
  'roocode',
  'kilocode',
  'antigravity',
  'dsh',
];

/** Every top-level command, in registration order; written out for the same reason. */
export const COMMAND_NAMES: readonly string[] = [
  'summary',
  'daily',
  'weekly',
  'monthly',
  'compare',
  'efficiency',
  'optimize',
  'trends',
  'session',
  'wrapped',
  'events',
  'statusline',
  'doctor',
  'prune',
  'config',
  'machine',
  'sync',
  'schema',
  'completion',
];

const updateGoldens = process.env.UPDATE_GOLDENS === '1';
const writtenGoldens: string[] = [];
const checkedGoldens = new Set<string>();

/**
 * Compares `text` byte for byte with `tests/golden/__goldens__/<name>`. With
 * `UPDATE_GOLDENS=1` it rewrites the file when the content differs instead, and
 * `useGoldenUpdateCheck` then fails the file so an update run only passes when nothing moved.
 */
export async function expectGolden(name: string, text: string): Promise<void> {
  checkedGoldens.add(name);
  const goldenPath = path.join(GOLDENS_DIR, name);
  let expected: string | undefined;

  try {
    expected = await readFile(goldenPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  if (updateGoldens) {
    if (expected !== text) {
      await mkdir(path.dirname(goldenPath), { recursive: true });
      await writeFile(goldenPath, text);
      writtenGoldens.push(name);
    }

    return;
  }

  if (expected === undefined) {
    throw new Error(`missing golden ${name}; run with UPDATE_GOLDENS=1 to create it`);
  }

  expect(text, `golden ${name}`).toBe(expected);
}

/**
 * Registers the `afterAll` that fails an update run which wrote any golden, and fails a run
 * that did not check every name in `expected` (so a fixed-name golden a test stops writing
 * cannot linger on disk unchecked).
 */
export function useGoldenUpdateCheck(expected: readonly string[] = []): void {
  afterAll(() => {
    if (writtenGoldens.length > 0) {
      throw new Error(
        `goldens updated: ${writtenGoldens.join(', ')}; rerun without UPDATE_GOLDENS`,
      );
    }

    const unchecked = expected.filter((name) => !checkedGoldens.has(name));

    if (unchecked.length > 0) {
      throw new Error(`goldens never checked in this file: ${unchecked.join(', ')}`);
    }
  });
}

function replacePath(text: string, absolutePath: string, placeholder: string): string {
  const jsonEscaped = JSON.stringify(absolutePath).slice(1, -1);
  const replaced = text.replaceAll(absolutePath, placeholder);
  return jsonEscaped === absolutePath ? replaced : replaced.replaceAll(jsonEscaped, placeholder);
}

function pathForms(absolutePath: string): string[] {
  const canonicalPath = realpathSync.native(absolutePath);
  return canonicalPath === absolutePath ? [absolutePath] : [canonicalPath, absolutePath];
}

/**
 * Replaces the per-file temp root with `<tmp>` and the fixture root with `<fixtures>`,
 * raw and JSON-escaped. Nothing else is normalized.
 */
export function normalizePaths(text: string, tempRoot: string): string {
  let normalized = text;

  for (const form of pathForms(tempRoot)) {
    normalized = replacePath(normalized, form, '<tmp>');
  }

  for (const form of pathForms(FIXTURES_ROOT)) {
    normalized = replacePath(normalized, form, '<fixtures>');
  }

  return normalized;
}

/**
 * Fakes only `Date` (IO, workers and timers keep working) at `FIXED_NOW`. Call inside
 * `beforeAll`; `vi.useRealTimers()` in `afterAll` undoes it.
 */
export function freezeDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
}

export const fixedNow = (): Date => FIXED_NOW;

/** What a report prints on stdout, through `console.log` or `process.stdout.write`; stderr is dropped. */
export async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(`${format(...args)}\n`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await run();
  } finally {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }

  return chunks.join('');
}

export type SourceOptions = Pick<
  EventsCommandOptions,
  | 'piDir'
  | 'codexDir'
  | 'copilotDir'
  | 'geminiDir'
  | 'droidDir'
  | 'claudeDir'
  | 'openclawDir'
  | 'opencodeDb'
  | 'gooseDb'
  | 'ampDir'
  | 'qwenDir'
  | 'kimiDir'
  | 'clineDir'
  | 'roocodeDir'
  | 'kilocodeDir'
  | 'antigravityDir'
  | 'dshDir'
>;

type SourceOptionKey = keyof SourceOptions;

/** One fixture set: the source it feeds and, for a golden set, its directory name. */
export type FixtureSet = {
  source: string;
  /** Undefined for the e2e set; the directory name under `tests/fixtures/golden/<source>/`. */
  name: string | undefined;
};

function getOptionKey(sourceId: string): SourceOptionKey {
  const option = getSourceOverrideOptions().find((candidate) => candidate.id === sourceId);

  if (!option) {
    throw new Error(`no override option for source ${sourceId}`);
  }

  return option.optionKey;
}

/** Sets the mtime of every file and directory under `dir` to `FIXED_NOW`, and checks every file's. */
export async function pinMtimes(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const paths = entries.map((entry) => path.join(entry.parentPath, entry.name));

  for (const entryPath of [...paths, dir]) {
    await utimes(entryPath, FIXED_NOW, FIXED_NOW);
  }

  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const filePath = path.join(entry.parentPath, entry.name);
    const { mtimeMs } = await stat(filePath);

    if (mtimeMs !== FIXED_NOW.getTime()) {
      throw new Error(`${filePath}: mtime ${mtimeMs}, expected ${FIXED_NOW.getTime()}`);
    }
  }
}

function copiedFixturesRoot(tempRoot: string): string {
  return path.join(tempRoot, 'fixtures');
}

/**
 * Copies `tests/fixtures/e2e` and `tests/fixtures/golden` under `tempRoot` with every mtime
 * at `FIXED_NOW`. Most adapters declare `eventsPrecedeFileMtime` (`rg eventsPrecedeFileMtime
 * src/sources`), and a windowed run skips their files whose newest mtime predates `since`
 * minus a day, so checkout mtimes would otherwise decide what an old clone reports.
 */
export async function copyFixtures(tempRoot: string): Promise<{ e2eRoot: string }> {
  const copyRoot = copiedFixturesRoot(tempRoot);

  await cp(E2E_FIXTURES_ROOT, path.join(copyRoot, 'e2e'), { recursive: true });
  await mkdir(path.join(copyRoot, 'golden'));

  for (const source of await listDirectories(GOLDEN_FIXTURES_ROOT)) {
    await cp(path.join(GOLDEN_FIXTURES_ROOT, source), path.join(copyRoot, 'golden', source), {
      recursive: true,
    });
  }

  await pinMtimes(copyRoot);
  return { e2eRoot: path.join(copyRoot, 'e2e') };
}

/**
 * Builds the e2e option for each source from a copy of the fixtures under `tempRoot` (see
 * `copyFixtures`), generating the SQLite and dsh fixtures there too.
 */
export async function createE2eSourceOptions(tempRoot: string): Promise<SourceOptions> {
  const { e2eRoot } = await copyFixtures(tempRoot);
  const generatedDir = path.join(tempRoot, 'e2e-generated');
  const antigravityDir = path.join(generatedDir, 'antigravity');
  const dshDir = path.join(generatedDir, 'dsh');
  const opencodeDb = path.join(generatedDir, 'opencode.db');
  const gooseDb = path.join(generatedDir, 'goose.db');

  await mkdir(antigravityDir, { recursive: true });
  createOpenCodeFixtureDb(opencodeDb, E2E_OPENCODE_MESSAGES);
  createGooseFixtureDb(gooseDb, E2E_GOOSE_SESSIONS);
  createAntigravityFixtureDb(path.join(antigravityDir, 'conversation.db'), E2E_ANTIGRAVITY_FIXTURE);
  await createDshSessionsFixture(dshDir);

  const generated: Partial<Record<string, string>> = {
    opencode: opencodeDb,
    goose: gooseDb,
    antigravity: antigravityDir,
    dsh: dshDir,
    qwen: path.join(e2eRoot, 'qwen', 'projects'),
  };
  const options: SourceOptions = {};

  for (const sourceId of ALL_SOURCE_IDS) {
    options[getOptionKey(sourceId)] = generated[sourceId] ?? path.join(e2eRoot, sourceId);
  }

  return options;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

/**
 * `tests/fixtures/golden/<source>/<set>/` for registered sources; directories starting with
 * `_` hold fixtures that are not a source's (for example machine bundles).
 */
async function scanGoldenFixtureSets(): Promise<FixtureSet[]> {
  const sets: FixtureSet[] = [];

  for (const source of await listDirectories(GOLDEN_FIXTURES_ROOT)) {
    if (source.startsWith('_') || !ALL_SOURCE_IDS.includes(source)) {
      continue;
    }

    for (const name of await listDirectories(path.join(GOLDEN_FIXTURES_ROOT, source))) {
      if (!name.startsWith('_')) {
        sets.push({ source, name });
      }
    }
  }

  return sets;
}

/** The e2e set of every source, then the golden sets. */
export async function listFixtureSets(): Promise<FixtureSet[]> {
  return [
    ...ALL_SOURCE_IDS.map((source) => ({ source, name: undefined })),
    ...(await scanGoldenFixtureSets()),
  ];
}

/**
 * The options that point the set's source at the set: `e2eOptions` for the e2e set, the
 * copy `createE2eSourceOptions(tempRoot)` made for a golden set.
 */
export function getFixtureSetOptions(
  set: FixtureSet,
  e2eOptions: SourceOptions,
  tempRoot: string,
): SourceOptions {
  const optionKey = getOptionKey(set.source);

  if (set.name === undefined) {
    return { [optionKey]: e2eOptions[optionKey] };
  }

  const option = getSourceOverrideOptions().find((candidate) => candidate.id === set.source);

  if (!option?.supportsSourceDir) {
    throw new Error(
      `golden fixture set ${set.source}/${set.name}: ${set.source} reads a database file, which the catalogue cannot point at yet`,
    );
  }

  return { [optionKey]: path.join(copiedFixturesRoot(tempRoot), 'golden', set.source, set.name) };
}

export function getFixtureSetLabel(set: FixtureSet): string {
  return set.name === undefined ? set.source : `${set.source}-${set.name}`;
}

/*
 * Golden names. Every test passes `expectGolden` a name from here, and
 * `orphans.golden.test.ts` checks that `listExpectedGoldenNames` matches the files on disk,
 * so a golden nothing writes any more cannot linger.
 */

/** Goldens whose name does not depend on a source, command or report case. */
export const FIXED_GOLDENS = {
  eventsAllSourcesJsonl: 'events/all-sources.jsonl',
  eventsAllSourcesCsv: 'events/all-sources.csv',
  eventsAllSourcesHashes: 'events/all-sources.hashes.txt',
  eventsOpencodeAppendedBefore: 'events/opencode-appended-before.jsonl',
  eventsOpencodeAppendedAfter: 'events/opencode-appended-after.jsonl',
  eventsStoreWarm: 'events/store-warm.jsonl',
  historyEventsWithDeparted: 'history/events-with-departed.jsonl',
  historyUsageMonthlyWithHistory: 'history/usage-monthly-with-history.json',
  historyUsageMonthlyWithoutHistory: 'history/usage-monthly-without-history.json',
  machinesExport: 'machines/export.jsonl',
  machinesUsageMonthlyByMachine: 'machines/usage-monthly-by-machine.json',
  machinesSummary: 'machines/summary.json',
  defaultPathsDoctor: 'default-paths/doctor.json',
  variantsStatuslineAllSources: 'variants/statusline-all-sources.txt',
} as const;

export function eventsGoldenName(set: FixtureSet): string {
  return `events/${getFixtureSetLabel(set)}.jsonl`;
}

/** `help/root.txt` for the root command, `help/<command>.txt` otherwise. */
export function helpGoldenName(command: string | undefined): string {
  return `help/${command ?? 'root'}.txt`;
}

export type ReportFormat = 'json' | 'markdown' | 'terminal';

const REPORT_FORMAT_EXTENSIONS: Record<ReportFormat, string> = {
  json: 'json',
  markdown: 'md',
  terminal: 'txt',
};

const ALL_FORMATS: readonly ReportFormat[] = ['json', 'markdown', 'terminal'];
const JSON_ONLY: readonly ReportFormat[] = ['json'];
const NO_MARKDOWN: readonly ReportFormat[] = ['json', 'terminal'];
const TERMINAL_ONLY: readonly ReportFormat[] = ['terminal'];

/** Each report case, `<command>[-<granularity>][-<variant>]`, and the formats it is frozen in. */
export const REPORT_CASE_FORMATS = {
  'usage-daily': ALL_FORMATS,
  'usage-weekly': ALL_FORMATS,
  'usage-monthly': ALL_FORMATS,
  'usage-daily-compact': TERMINAL_ONLY,
  'usage-daily-per-model-columns': TERMINAL_ONLY,
  'usage-daily-no-cost': TERMINAL_ONLY,
  summary: ALL_FORMATS,
  compare: ALL_FORMATS,
  'trends-tokens': ALL_FORMATS,
  'trends-active-hours': JSON_ONLY,
  'trends-by-source': JSON_ONLY,
  session: ALL_FORMATS,
  'session-top-5': JSON_ONLY,
  'session-by-repo': JSON_ONLY,
  'efficiency-daily': JSON_ONLY,
  'efficiency-weekly': JSON_ONLY,
  'efficiency-monthly': ALL_FORMATS,
  'optimize-monthly': ALL_FORMATS,
  wrapped: ALL_FORMATS,
  doctor: NO_MARKDOWN,
  prune: NO_MARKDOWN,
} as const satisfies Record<string, readonly ReportFormat[]>;

export type ReportCaseName = keyof typeof REPORT_CASE_FORMATS;

export function reportGoldenName(caseName: ReportCaseName, format: ReportFormat): string {
  return `reports/${caseName}.${REPORT_FORMAT_EXTENSIONS[format]}`;
}

/** Every golden name the golden tests write, sorted. */
export async function listExpectedGoldenNames(): Promise<string[]> {
  const reportNames = Object.entries(REPORT_CASE_FORMATS).flatMap(([caseName, formats]) =>
    formats.map((format) => reportGoldenName(caseName as ReportCaseName, format)),
  );

  return [
    ...Object.values(FIXED_GOLDENS),
    ...(await listFixtureSets()).map(eventsGoldenName),
    helpGoldenName(undefined),
    ...COMMAND_NAMES.map(helpGoldenName),
    ...reportNames,
  ].sort();
}
