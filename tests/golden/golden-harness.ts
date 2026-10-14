import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, expect, vi } from 'vitest';

import type { EventsCommandOptions } from '../../src/cli/usage-data-contracts.js';
import {
  getDefaultSourceIds,
  getSourceOverrideOptions,
} from '../../src/sources/create-default-adapters.js';
import { createAntigravityFixtureDb } from '../helpers/antigravity-fixtures.js';
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

/** Every registered source, in registration order. */
export const ALL_SOURCE_IDS = getDefaultSourceIds();

const updateGoldens = process.env.UPDATE_GOLDENS === '1';
const writtenGoldens: string[] = [];

/**
 * Compares `text` byte for byte with `tests/golden/__goldens__/<name>`. With
 * `UPDATE_GOLDENS=1` it rewrites the file when the content differs instead, and
 * `useGoldenUpdateCheck` then fails the file so an update run only passes when nothing moved.
 */
export async function expectGolden(name: string, text: string): Promise<void> {
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

/** Registers the `afterAll` that fails an update run which wrote any golden. */
export function useGoldenUpdateCheck(): void {
  afterAll(() => {
    if (writtenGoldens.length > 0) {
      throw new Error(
        `goldens updated: ${writtenGoldens.join(', ')}; rerun without UPDATE_GOLDENS`,
      );
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
    chunks.push(`${args.map(String).join(' ')}\n`);
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
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

// Mirrors the antigravity turn inline in tests/e2e/multi-source.e2e.test.ts; it belongs in
// tests/helpers/antigravity-fixtures.ts, which this task does not own.
const E2E_ANTIGRAVITY_FIXTURE = {
  turns: [
    {
      model: 'gemini-antigravity-e2e',
      timestamp: { seconds: 1_781_510_400 },
      usage: {
        modelEnum: 1016,
        inputTokens: 40,
        cacheReadTokens: 5,
        totalOutputTokens: 20,
        outputTokens: 15,
        reasoningTokens: 5,
        responseId: 'antigravity-e2e-response',
      },
    },
  ],
};

/** Builds the e2e option for each source, generating the SQLite and dsh fixtures under `tempRoot`. */
export async function createE2eSourceOptions(tempRoot: string): Promise<SourceOptions> {
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
    qwen: path.join(E2E_FIXTURES_ROOT, 'qwen', 'projects'),
  };
  const options: SourceOptions = {};

  for (const sourceId of ALL_SOURCE_IDS) {
    options[getOptionKey(sourceId)] = generated[sourceId] ?? path.join(E2E_FIXTURES_ROOT, sourceId);
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

/** The options that point the set's source at the set. */
export function getFixtureSetOptions(set: FixtureSet, e2eOptions: SourceOptions): SourceOptions {
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

  return { [optionKey]: path.join(GOLDEN_FIXTURES_ROOT, set.source, set.name) };
}

export function getFixtureSetLabel(set: FixtureSet): string {
  return set.name === undefined ? set.source : `${set.source}-${set.name}`;
}
