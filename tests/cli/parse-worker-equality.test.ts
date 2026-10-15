import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectFile,
  createSourceContext,
  type SourceAdapter,
  type SourceParseFileDiagnostics,
} from '@ayagmar/agent-sessions';
import { createDefaultAdapters, type SourceSelection } from '@ayagmar/agent-sessions/registry';
import { getParseWorkerRoots, handleParseWorkerRequest } from '../../src/cli/parse-worker-pool.js';
import { writeClaudeForkSession, writePiParentAndFork } from '../helpers/fork-fixtures.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(canonicalTmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type FileParse = { filePath: string; diagnostics: SourceParseFileDiagnostics };

async function parseInline(adapter: SourceAdapter, files: string[]): Promise<FileParse[]> {
  const parses: FileParse[] = [];

  for (const filePath of files) {
    parses.push({ filePath, diagnostics: await collectFile(adapter, filePath) });
  }

  return parses;
}

/** Parses each file as a worker does: the task carries the owning adapter's roots. */
async function parseOnWorker(adapter: SourceAdapter, files: string[]): Promise<FileParse[]> {
  const adapterCache = new Map<string, SourceAdapter>();
  const parses: FileParse[] = [];

  for (const [index, filePath] of files.entries()) {
    const response = await handleParseWorkerRequest(
      {
        taskId: index + 1,
        sourceId: adapter.id,
        filePath,
        roots: getParseWorkerRoots(adapter, filePath),
      },
      adapterCache,
    );

    if (!response.ok) {
      throw new Error(response.error);
    }

    parses.push({ filePath, diagnostics: response.diagnostics });
  }

  return parses;
}

async function expectWorkerToMatchInline(
  selection: SourceSelection,
  homeDir: string,
): Promise<FileParse[]> {
  const [adapter] = createDefaultAdapters(selection, createSourceContext({ homeDir, env: {} }));
  const files = await adapter.discoverFiles();
  const inline = await parseInline(adapter, files);

  expect(files.length).toBeGreaterThan(0);
  expect(await parseOnWorker(adapter, files)).toEqual(inline);
  return inline;
}

function countEvents(parses: FileParse[]): number {
  return parses.reduce((sum, parse) => sum + parse.diagnostics.events.length, 0);
}

describe('worker parse equals inline parse', () => {
  it('skips claude fork rows only when the parent is inside --claude-dir, like inline', async () => {
    const root = await createTempDir('worker-eq-claude-');
    const projectDir = path.join(root, 'projects', 'repo');
    const subagentsDir = await writeClaudeForkSession(projectDir);

    const parentInside = await expectWorkerToMatchInline(
      { sourceIds: ['claude'], roots: new Map([['claude', [path.join(root, 'projects')]]]) },
      root,
    );
    const parentOutside = await expectWorkerToMatchInline(
      { sourceIds: ['claude'], roots: new Map([['claude', [subagentsDir]]]) },
      root,
    );

    // Parent counted: one parent row and one fresh row per fork; otherwise the replays stay.
    expect(countEvents(parentInside)).toBe(3);
    expect(countEvents(parentOutside)).toBe(4);
    expect(parentInside.some((parse) => parse.diagnostics.skippedRows > 0)).toBe(true);
  });

  it('finds a claude fork parent under another --claude-dir, like inline', async () => {
    const root = await createTempDir('worker-eq-claude-two-dirs-');
    const projectDir = path.join(root, 'projects', 'repo');
    const subagentsDir = await writeClaudeForkSession(projectDir);
    const otherDir = path.join(root, 'other');
    await mkdir(otherDir);

    const parses = await expectWorkerToMatchInline(
      {
        sourceIds: ['claude'],
        roots: new Map([['claude', [subagentsDir, path.join(root, 'projects'), otherDir]]]),
      },
      root,
    );

    expect(countEvents(parses)).toBe(3);
  });

  it('keeps a pi fork whose parent sits in the other --pi-dir, like inline', async () => {
    const root = await createTempDir('worker-eq-pi-');
    const parentDir = path.join(root, 'a');
    const forkDir = path.join(root, 'b');
    await writePiParentAndFork(parentDir, forkDir);

    const parses = await expectWorkerToMatchInline(
      { sourceIds: ['pi'], roots: new Map([['pi', [parentDir, forkDir]]]) },
      root,
    );

    // Each --pi-dir parses on its own, so the parent in the other dir is not counted.
    expect(countEvents(parses)).toBe(3);
    expect(parses.some((parse) => parse.diagnostics.skippedRows > 0)).toBe(true);
  });

  it('builds the worker adapter from the default roots of a non-default home', async () => {
    const home = await createTempDir('worker-eq-home-');
    await writeClaudeForkSession(path.join(home, '.claude', 'projects', 'repo'));
    const piSessions = path.join(home, '.pi', 'agent', 'sessions');
    // The parent sits in ~/.omp, the fork in ~/.pi: one adapter scans both defaults.
    await writePiParentAndFork(path.join(home, '.omp', 'agent', 'sessions'), piSessions);

    const claude = await expectWorkerToMatchInline({ sourceIds: ['claude'] }, home);
    const pi = await expectWorkerToMatchInline({ sourceIds: ['pi'] }, home);

    expect(countEvents(claude)).toBe(3);
    expect(countEvents(pi)).toBe(2);
  });
});
