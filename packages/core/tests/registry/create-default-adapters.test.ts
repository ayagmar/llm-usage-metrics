import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EVENT_KINDS } from '../../src/domain/session-event.js';
import { createDefaultAdapters } from '../../src/registry/index.js';
import { createSourceContext } from '../../src/sources/source-context.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

describe('createDefaultAdapters', () => {
  it('builds default adapters in stable order', () => {
    const adapters = createDefaultAdapters({});

    expect(adapters.map((adapter) => adapter.id)).toEqual([
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
    ]);
  });

  // Any `kinds` with usage passes here: sources widen it as they gain event kinds.
  function getCapabilitiesBesidesKinds(sourceId: string) {
    const adapter = createDefaultAdapters({}).find((candidate) => candidate.id === sourceId);
    const { kinds, ...capabilities } = adapter?.capabilities ?? {};

    expect(kinds, sourceId).toContain('usage');
    return capabilities;
  }

  it('exposes source capabilities for provider pruning', () => {
    expect(getCapabilitiesBesidesKinds('codex')).toEqual({
      fixedProviderRoots: ['openai'],
      eventsPrecedeFileMtime: true,
      dependenciesFollowFile: true,
    });
    expect(getCapabilitiesBesidesKinds('gemini')).toEqual({
      fixedProviderRoots: ['google'],
      eventsPrecedeFileMtime: true,
    });
  });

  it('declares the event kinds of every source, usage included', () => {
    for (const adapter of createDefaultAdapters({})) {
      const kinds = adapter.capabilities?.kinds ?? [];

      expect(kinds, adapter.id).toContain('usage');
      expect(
        kinds.filter((kind) => !EVENT_KINDS.includes(kind)),
        adapter.id,
      ).toEqual([]);
      expect(new Set(kinds).size, adapter.id).toBe(kinds.length);
    }
  });

  it('gives the SQLite sources no capability but kinds, so none skips files by mtime', () => {
    for (const sourceId of ['goose', 'opencode', 'antigravity']) {
      expect(getCapabilitiesBesidesKinds(sourceId), sourceId).toEqual({});
    }
  });

  it('lets only file-per-session sources skip files by mtime', () => {
    const adapters = createDefaultAdapters({});
    const skippable = adapters
      .filter((adapter) => adapter.capabilities?.eventsPrecedeFileMtime)
      .map((adapter) => adapter.id);
    const notSkippable = adapters
      .filter((adapter) => !adapter.capabilities?.eventsPrecedeFileMtime)
      .map((adapter) => adapter.id);

    // SQLite sources keep events in a database whose mtime does not track each row.
    expect(notSkippable.sort()).toEqual(['antigravity', 'goose', 'opencode']);
    expect(skippable.length + notSkippable.length).toBe(adapters.length);
  });

  it('builds only the selected sources, in registration order', () => {
    const adapters = createDefaultAdapters({ sourceIds: ['dsh', 'codex', 'pi'] });

    expect(adapters.map((adapter) => adapter.id)).toEqual(['pi', 'codex', 'dsh']);
  });
});

describe('createDefaultAdapters roots', () => {
  let rootDir = '';
  let existingDir = '';
  let sessionFile = '';
  let missingDir = '';

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'create-default-adapters-'));
    existingDir = path.join(rootDir, 'existing');
    missingDir = path.join(rootDir, 'missing');
    sessionFile = path.join(existingDir, 'project', 'session.jsonl');
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, '');
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function discover(sourceId: string, roots: readonly string[], required: boolean) {
    const [adapter] = createDefaultAdapters(
      {
        sourceIds: [sourceId],
        roots: new Map([[sourceId, roots]]),
        requireExistingRoots: new Set(required ? [sourceId] : []),
      },
      createSourceContext({ homeDir: rootDir, env: {}, platform: 'linux' }),
    );

    return adapter.discoverFiles();
  }

  // pi: one adapter per root behind MultiDirectorySourceAdapter.
  // claude: one adapter over every root, for fork deduplication.
  for (const sourceId of ['pi', 'claude']) {
    it(`${sourceId}: a required missing root fails, single or among several`, async () => {
      await expect(discover(sourceId, [missingDir], true)).rejects.toThrow(missingDir);
      await expect(discover(sourceId, [existingDir, missingDir], true)).rejects.toThrow(missingDir);
    });

    it(`${sourceId}: an optional missing root is skipped, single or among several`, async () => {
      await expect(discover(sourceId, [missingDir], false)).resolves.toEqual([]);
      await expect(discover(sourceId, [existingDir, missingDir], false)).resolves.toEqual([
        sessionFile,
      ]);
    });
  }
});
