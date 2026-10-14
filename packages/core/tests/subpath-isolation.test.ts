import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// Importing one `./sources/<id>` entry must not load another source's readers. roocode and
// kilocode are built by the cline family adapter, so they may load cline.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sourcesRoot = path.join(packageRoot, 'src', 'sources');
const distSourcesRoot = path.join(packageRoot, 'dist', 'sources');

const SHARED_SOURCE_DIRECTORIES: Record<string, readonly string[]> = {
  roocode: ['cline'],
  kilocode: ['cline'],
};

const sourceIds = readdirSync(sourcesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => existsSync(path.join(sourcesRoot, entry.name, 'index.ts')))
  .map((entry) => entry.name)
  .sort();

function otherSourceDirectories(sourceId: string): string[] {
  const allowed = new Set([sourceId, ...(SHARED_SOURCE_DIRECTORIES[sourceId] ?? [])]);
  return sourceIds.filter((id) => !allowed.has(id));
}

function listModules(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => path.join(directory, entry));
}

/** The modules under `directories` that importing `entry` evaluates, in a fresh graph. */
async function modulesLoadedBy(entry: string, directories: readonly string[]): Promise<string[]> {
  const loaded: string[] = [];
  const watched = directories.flatMap((directory) =>
    listModules(path.join(sourcesRoot, directory)),
  );

  vi.resetModules();
  for (const modulePath of watched) {
    vi.doMock(modulePath, async (importOriginal) => {
      loaded.push(path.relative(sourcesRoot, modulePath));
      return importOriginal();
    });
  }

  try {
    // eslint-disable-next-line no-restricted-syntax -- loading the entry is what is tested
    await import(pathToFileURL(entry).href);
  } finally {
    for (const modulePath of watched) {
      vi.doUnmock(modulePath);
    }
    vi.resetModules();
  }

  return loaded;
}

describe('source subpath isolation', () => {
  it('finds every source entry', () => {
    expect(sourceIds).toContain('codex');
    expect(sourceIds).toContain('roocode');
  });

  it('importing "." evaluates no source module', async () => {
    const entry = path.join(packageRoot, 'src', 'index.ts');

    expect(await modulesLoadedBy(entry, sourceIds)).toEqual([]);
  });

  it.each(sourceIds)('importing ./sources/%s evaluates no other source module', async (id) => {
    const entry = path.join(sourcesRoot, id, 'index.ts');

    expect(await modulesLoadedBy(entry, otherSourceDirectories(id))).toEqual([]);
  });
});

// The built entries, after `core:build`: tsup splits shared code into chunks, so follow
// each entry's static imports and read which source files its source maps cover.
const STATIC_IMPORT = /^(?:import|export)\s[^;]*?\sfrom\s*"(\.{1,2}\/[^"]+)";?$/gm;

function staticImportClosure(entryFile: string): string[] {
  const seen = new Set<string>();
  const pending = [entryFile];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);

    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      pending.push(path.resolve(path.dirname(file), match[1]));
    }
  }

  return [...seen];
}

function mappedSources(jsFile: string): string[] {
  const map = JSON.parse(readFileSync(`${jsFile}.map`, 'utf8')) as { sources: string[] };
  return map.sources.map((source) => path.resolve(path.dirname(jsFile), source));
}

describe.skipIf(!existsSync(distSourcesRoot))('built source subpath isolation', () => {
  it.each(sourceIds)('dist/sources/%s bundles no other source module', (id) => {
    const files = staticImportClosure(path.join(distSourcesRoot, id, 'index.js'));
    const sources = new Set(files.flatMap(mappedSources));
    const leaked = otherSourceDirectories(id).flatMap((other) =>
      [...sources].filter((source) => source.startsWith(path.join(sourcesRoot, other) + path.sep)),
    );

    // Every adapter builds events, and the event factory sits in a shared chunk.
    expect(sources).toContain(path.join(packageRoot, 'src', 'domain', 'usage-event.ts'));
    expect(leaked.map((source) => path.relative(sourcesRoot, source))).toEqual([]);
  });
});
