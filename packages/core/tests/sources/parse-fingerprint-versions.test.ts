import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultAdapters, getDefaultSourceIds } from '../../src/registry/index.js';
import { getFileFingerprint } from '../../src/sources/parse-fingerprint.js';
import { createSourceContext } from '../../src/sources/source-context.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

// The parse cache key of every source. A change here re-parses every stored file of that
// source, so move a row only together with a deliberate `parserVersion` or
// USAGE_EVENT_NORMALIZATION_VERSION bump.
const EXPECTED_PARSER_VERSIONS: Record<string, string> = {
  pi: 'n4.p5',
  codex: 'n4.p6',
  gemini: 'n4.p4',
  droid: 'n4.p2',
  opencode: 'n4.p5',
  openclaw: 'n4.p4',
  claude: 'n4.p4',
  copilot: 'n4.p2',
  goose: 'n4.p2',
  amp: 'n4.p2',
  qwen: 'n4.p4',
  kimi: 'n4.p1',
  cline: 'n4.p3',
  roocode: 'n4.p3',
  kilocode: 'n4.p3',
  antigravity: 'n4.p2',
  dsh: 'n4.p5',
};

let rootDir = '';
let filePath = '';

beforeAll(async () => {
  rootDir = await mkdtemp(path.join(canonicalTmpdir(), 'parse-fingerprint-versions-'));
  filePath = path.join(rootDir, 'session.jsonl');
  await writeFile(filePath, '');
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('parse fingerprint versions', () => {
  it('keeps the cache key of every registered source', async () => {
    // A temp home and an empty env keep the user's own source dirs out of the run.
    const adapters = createDefaultAdapters(
      {},
      createSourceContext({ homeDir: rootDir, env: {}, platform: 'linux' }),
    );
    const parserVersions: Record<string, string | undefined> = {};

    for (const adapter of adapters) {
      parserVersions[adapter.id] = (await getFileFingerprint(adapter, filePath))?.parserVersion;
    }

    expect(Object.keys(parserVersions)).toEqual(getDefaultSourceIds());
    expect(parserVersions).toEqual(EXPECTED_PARSER_VERSIONS);
  });
});
