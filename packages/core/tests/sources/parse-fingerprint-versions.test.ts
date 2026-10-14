import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultAdapters, getDefaultSourceIds } from '../../src/registry/index.js';
import { getParseFileFingerprint } from '../../src/sources/parse-fingerprint.js';
import { createSourceContext } from '../../src/sources/source-context.js';
import { canonicalTmpdir } from '../helpers/tmp.js';

// The parse cache key of every source. A change here re-parses every stored file of that
// source, so move a row only together with a deliberate `parserVersion` or
// USAGE_EVENT_NORMALIZATION_VERSION bump.
const EXPECTED_PARSER_VERSIONS: Record<string, string> = {
  pi: 'n2.p5',
  codex: 'n2.p2',
  gemini: 'n2.p4',
  droid: 'n2.p2',
  opencode: 'n2.p2',
  openclaw: 'n2.p4',
  claude: 'n2.p4',
  copilot: 'n2.p2',
  goose: 'n2.p2',
  amp: 'n2.p2',
  qwen: 'n2.p4',
  kimi: 'n2.p1',
  cline: 'n2.p3',
  roocode: 'n2.p3',
  kilocode: 'n2.p3',
  antigravity: 'n2.p2',
  dsh: 'n2.p4',
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
      parserVersions[adapter.id] = (await getParseFileFingerprint(adapter, filePath))
        ?.parserVersion;
    }

    expect(Object.keys(parserVersions)).toEqual(getDefaultSourceIds());
    expect(parserVersions).toEqual(EXPECTED_PARSER_VERSIONS);
  });
});
