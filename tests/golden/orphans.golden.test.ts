import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';
import { getDefaultSourceIds } from '../../src/sources/create-default-adapters.js';
import {
  ALL_SOURCE_IDS,
  COMMAND_NAMES,
  GOLDENS_DIR,
  listExpectedGoldenNames,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

async function listGoldenFiles(): Promise<string[]> {
  const entries = await readdir(GOLDENS_DIR, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(GOLDENS_DIR, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`golden catalogue (${WINDOWS_SKIP_REASON})`, () => {
  // A dropped or renamed source or command must show up here and be handled on purpose,
  // with its goldens removed or renamed, rather than leave them unchecked on disk.
  it('lists every registered source', () => {
    expect(ALL_SOURCE_IDS).toEqual(getDefaultSourceIds());
  });

  it('lists every top-level command', () => {
    expect(COMMAND_NAMES).toEqual(createCli().commands.map((command) => command.name()));
  });

  it('holds exactly the goldens the golden tests write', async () => {
    expect(await listGoldenFiles()).toEqual(await listExpectedGoldenNames());
  });
});
