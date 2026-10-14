import { readdir } from 'node:fs/promises';
import type * as NodeOs from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Counts `os.homedir()` and a named `homedir()` import alike: both resolve here.
const { homedirCalls } = vi.hoisted(() => ({ homedirCalls: { count: 0 } }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  const homedir = () => {
    homedirCalls.count += 1;
    return actual.homedir();
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const sourcesDir = fileURLToPath(new URL('../src', import.meta.url));

async function listSourceModules(): Promise<string[]> {
  const entries = await readdir(sourcesDir, { recursive: true });

  return entries
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.d.ts'))
    .map((entry) => path.join(sourcesDir, entry))
    .sort();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('src/sources import side effects', () => {
  it('reads no home directory and patches no process warning hook at import', async () => {
    const modules = await listSourceModules();
    expect(modules).toContain(path.join(sourcesDir, 'registry', 'index.ts'));

    vi.resetModules();
    homedirCalls.count = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity only
    const emitWarning = process.emitWarning;

    for (const modulePath of modules) {
      // eslint-disable-next-line no-restricted-syntax -- loading each module is what is tested
      await import(pathToFileURL(modulePath).href);
    }

    expect(homedirCalls.count).toBe(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity only
    expect(process.emitWarning).toBe(emitWarning);
  });
});
