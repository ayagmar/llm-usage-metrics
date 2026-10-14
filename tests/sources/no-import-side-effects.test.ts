import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const sourcesDir = path.resolve('src/sources');

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
    expect(modules).toContain(path.join(sourcesDir, 'create-default-adapters.ts'));

    vi.resetModules();
    const homedir = vi.spyOn(os, 'homedir');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity only
    const emitWarning = process.emitWarning;

    for (const modulePath of modules) {
      // eslint-disable-next-line no-restricted-syntax -- loading each module is what is tested
      await import(pathToFileURL(modulePath).href);
    }

    expect(homedir).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- compared by identity only
    expect(process.emitWarning).toBe(emitWarning);
  });
});
